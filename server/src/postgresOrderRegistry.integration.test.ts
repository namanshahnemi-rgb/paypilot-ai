// PostgreSQL integration tests for PostgresOrderRegistry. They run against
// the database in DATABASE_URL (server/.env) with `npm run test:integration`
// and are not part of `npm test`, so CI needs no database.
//
// PayPal is replaced by the real capture logic with scripted responses, so no
// PayPal requests or payments are made. Each run uses order IDs with its own
// random prefix and deletes only those rows afterwards; no other data in the
// database is read or changed.
//
// If DATABASE_URL is missing or PostgreSQL can't be reached, every test fails
// with the reason, unless PG_INTEGRATION_ALLOW_SKIP=1 is set, in which case
// they are reported as skipped.
import { after, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import dotenv from "dotenv";
import type { Pool } from "pg";
import {
  capturePayPalOrder,
  captureRequestId,
  type ExpectedAmount,
} from "./paypalCapture.js";
import type { OrderRecord } from "./orderRegistry.js";
import {
  DEFAULT_CONNECTION_TIMEOUT_MS,
  DEFAULT_QUERY_TIMEOUT_MS,
  PostgresOrderRegistry,
  createPostgresPool,
  type PostgresRegistryOptions,
} from "./postgresOrderRegistry.js";

dotenv.config({ quiet: true });

const DATABASE_URL = process.env.DATABASE_URL?.trim() ?? "";
const ALLOW_SKIP = process.env.PG_INTEGRATION_ALLOW_SKIP === "1";
const RUN = `ITEST-${randomBytes(4).toString("hex").toUpperCase()}`;
const EXPECTED: ExpectedAmount = { value: "5.00", currency: "USD" };
const silentLogger = { log() {}, error() {} };

// A separate connection for checks and cleanup, outside the registries.
let admin: Pool | undefined;
let unavailable: string | undefined;

if (!DATABASE_URL) {
  unavailable = "DATABASE_URL is not set";
} else {
  admin = createPostgresPool(DATABASE_URL, {
    application_name: `${RUN}-admin`,
    max: 2,
    connectionTimeoutMillis: 5000,
  });
  try {
    await admin.query("SELECT 1");
  } catch (error) {
    unavailable = `PostgreSQL is not reachable (${error instanceof Error ? error.message : "unknown error"})`;
    await admin.end().catch(() => undefined);
    admin = undefined;
  }
}

after(async () => {
  if (!admin) return;
  try {
    const table = await admin.query<{ exists: boolean }>(
      "SELECT to_regclass('paypal_orders') IS NOT NULL AS exists",
    );
    if (table.rows[0]?.exists) {
      // Only this run's rows.
      await admin.query("DELETE FROM paypal_orders WHERE order_id LIKE $1", [`${RUN}-%`]);
    }
  } finally {
    await admin.end();
  }
});

function pgTest(name: string, fn: (t: TestContext, db: Pool) => Promise<void>) {
  const skip =
    unavailable && ALLOW_SKIP
      ? `${unavailable}; skipped because PG_INTEGRATION_ALLOW_SKIP=1`
      : false;
  test(name, { skip, timeout: 30_000 }, async (t) => {
    if (unavailable || !admin) {
      throw new Error(
        `${unavailable ?? "PostgreSQL is not available"}. These tests need the PostgreSQL database in DATABASE_URL; set PG_INTEGRATION_ALLOW_SKIP=1 to skip them instead.`,
      );
    }
    await fn(t, admin);
  });
}

let counter = 0;
const orderId = (label: string) => `${RUN}-${label}-${++counter}`;

// One backend instance: its own pool, tagged so its sessions can be found in
// pg_stat_activity. Closed when the test ends.
async function openInstance(t: TestContext, options: PostgresRegistryOptions = {}) {
  const name = `${RUN}-instance-${++counter}`;
  const registry = new PostgresOrderRegistry(
    createPostgresPool(DATABASE_URL, { application_name: name, max: 4 }),
    options,
  );
  t.after(() => registry.close());
  await registry.initialize();
  return { registry, name };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await delay(25);
  }
}

// Sessions of these instances that are waiting for (not holding) an
// advisory lock.
async function lockWaiters(db: Pool, names: string[]) {
  const result = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory' AND NOT l.granted AND a.application_name = ANY($1)`,
    [names],
  );
  return result.rows[0]?.n ?? 0;
}

async function sessionsInTransaction(db: Pool, name: string) {
  const result = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE application_name = $1 AND state = 'idle in transaction'`,
    [name],
  );
  return result.rows[0]?.n ?? 0;
}

// --- Fake PayPal --------------------------------------------------------------

type PayPalStep = { status: number; body: unknown } | { throws: unknown };

function capturedOrder(orderID: string, status = "COMPLETED", value = "5.00", currency = "USD") {
  return {
    id: orderID,
    status: "COMPLETED",
    payer: { email_address: "buyer@example.test", address: { country_code: "US" } },
    purchase_units: [
      {
        payments: {
          captures: [{ id: "CAPTURE1", status, amount: { value, currency_code: currency } }],
        },
      },
    ],
  };
}

const timeout = (): PayPalStep => ({
  throws: new DOMException("The operation timed out.", "TimeoutError"),
});

// Each capture first checks the order's status. This fake answers that
// check with an order in `approvalStatus` (APPROVED unless a test changes
// it); `steps` script the requests after it. hold() can hold either.
function fakePayPal(steps: PayPalStep[]) {
  const requests: Array<{ method: string; requestId: string | null }> = [];
  let held: { reached: () => void; released: Promise<void> } | undefined;
  let approvalStatus = "APPROVED";

  const runCapture = (orderID: string) => (expected: ExpectedAmount) => {
    let checked = false;
    return capturePayPalOrder(orderID, expected, {
      baseUrl: "https://paypal.test",
      accessToken: "fake-access-token-for-tests",
      logger: silentLogger,
      fetch: async (_url, init) => {
        requests.push({
          method: init.method ?? "GET",
          requestId: new Headers(init.headers).get("PayPal-Request-Id"),
        });
        if (held) {
          const current = held;
          held = undefined;
          current.reached();
          await current.released;
        }
        if (!checked) {
          checked = true;
          await delay(20);
          return new Response(JSON.stringify({ id: orderID, status: approvalStatus }), { status: 200 });
        }
        const step = steps.shift();
        if (!step) throw new Error("Unexpected extra PayPal request");
        if ("throws" in step) throw step.throws;
        await delay(20);
        return new Response(JSON.stringify(step.body), { status: step.status });
      },
    });
  };

  return {
    runCapture,
    setApprovalStatus: (status: string) => {
      approvalStatus = status;
    },
    approvalChecks: () => requests.filter((r) => r.method === "GET").length,
    addSteps: (...more: PayPalStep[]) => steps.push(...more),
    captureCalls: () => requests.filter((r) => r.method === "POST").length,
    captureRequestIds: () =>
      requests.filter((r) => r.method === "POST").map((r) => r.requestId),
    // Holds PayPal's next answer: `reached` resolves when PayPal is called,
    // and the answer is sent after release().
    hold() {
      let reached!: () => void;
      let release!: () => void;
      const reachedPromise = new Promise<void>((resolve) => (reached = resolve));
      const released = new Promise<void>((resolve) => (release = resolve));
      held = { reached, released };
      return { reached: reachedPromise, release };
    },
  };
}

// The error a capture gives when its database connection is lost.
const CONNECTION_LOST =
  /database connection was lost during the capture .*result was not confirmed\. Checking the order again is safe and will not charge twice\./;

function assertPaid(record: OrderRecord | undefined) {
  assert.ok(record);
  assert.equal(record.status, "PAID");
  assert.equal(record.captureStatus, "COMPLETED");
  assert.equal(record.capturedAmount, "5.00");
  assert.equal(record.capturedCurrency, "USD");
  assert.deepEqual(record.expected, EXPECTED);
}

// --- Schema and registration ------------------------------------------------

pgTest("schema initialization creates the table and indexes, and can run repeatedly and concurrently", async (t, db) => {
  const a = await openInstance(t);
  const b = await openInstance(t);

  await Promise.all([a.registry.initialize(), b.registry.initialize(), a.registry.initialize()]);
  await b.registry.initialize();

  const columns = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'paypal_orders'
      ORDER BY ordinal_position`,
  );
  assert.deepEqual(
    columns.rows.map((row) => row.column_name),
    [
      "order_id",
      "expected_amount",
      "expected_currency",
      "created_at",
      "updated_at",
      "payment_status",
      "order_status",
      "capture_status",
      "captured_amount",
      "captured_currency",
      "message",
      "checkout_token_hash",
    ],
  );

  const indexes = await db.query<{ indexname: string }>(
    "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'paypal_orders'",
  );
  const indexNames = indexes.rows.map((row) => row.indexname);
  for (const index of ["paypal_orders_pkey", "idx_paypal_orders_status", "idx_paypal_orders_created_at"]) {
    assert.ok(indexNames.includes(index), `index ${index} exists`);
  }

  const migrations = await db.query("SELECT version FROM schema_migrations WHERE version IN (1, 2)");
  assert.equal(migrations.rowCount, 2);

  // The status column only accepts known payment states.
  await assert.rejects(
    db.query(
      `INSERT INTO paypal_orders
         (order_id, expected_amount, expected_currency, created_at, updated_at, payment_status)
       VALUES ($1, '5.00', 'USD', NOW(), NOW(), 'REFUNDED')`,
      [orderId("CHECK")],
    ),
    { code: "23514" },
  );
});

pgTest("registering an order records it as CREATED, and registering it again changes nothing", async (t) => {
  const { registry } = await openInstance(t);
  const id = orderId("REGISTER");

  const created = await registry.register(id, EXPECTED);
  assert.equal(created.orderID, id);
  assert.deepEqual(created.expected, EXPECTED);
  assert.equal(created.status, "CREATED");
  assert.ok(created.createdAt instanceof Date);
  assert.deepEqual(created.updatedAt, created.createdAt);
  for (const field of ["orderStatus", "captureStatus", "capturedAmount", "capturedCurrency", "message"] as const) {
    assert.equal(created[field], null, field);
  }

  const again = await registry.register(id, { value: "10.00", currency: "EUR" });
  assert.deepEqual(again, created, "the original amount and time are kept");
  assert.deepEqual(await registry.get(id), created);
  assert.equal(await registry.get(orderId("MISSING")), undefined);
});

pgTest("registered orders persist after the registry is closed and reopened", async (t) => {
  const id = orderId("PERSIST");
  const first = await openInstance(t);
  const created = await first.registry.register(id, EXPECTED);
  await first.registry.close();

  const second = await openInstance(t);
  assert.deepEqual(await second.registry.get(id), created);
});

pgTest("a completed payment persists after a restart and is never captured or reset again", async (t, db) => {
  const id = orderId("PAID");
  const paypal = fakePayPal([{ status: 201, body: capturedOrder(id) }]);

  const first = await openInstance(t);
  await first.registry.register(id, EXPECTED);
  const paid = await first.registry.capture(id, paypal.runCapture(id));
  assertPaid(paid);
  await first.registry.close();

  const second = await openInstance(t);
  assert.deepEqual(await second.registry.get(id), paid);
  assert.deepEqual(await second.registry.capture(id, paypal.runCapture(id)), paid);
  assert.equal((await second.registry.register(id, EXPECTED)).status, "PAID");
  assert.equal(paypal.captureCalls(), 1, "PayPal was called once in total");

  // No buyer data is stored.
  const row = await db.query("SELECT * FROM paypal_orders WHERE order_id = $1", [id]);
  const stored = JSON.stringify(row.rows[0]);
  assert.ok(!stored.includes("buyer@example.test"));
  assert.ok(!/payer|country/i.test(stored));
});

// --- Capture coordination across instances -----------------------------------

pgTest("two instances capturing the same order at once make one PayPal call", async (t, db) => {
  const id = orderId("CONCURRENT");
  const a = await openInstance(t);
  const b = await openInstance(t);
  await a.registry.register(id, EXPECTED);

  const paypal = fakePayPal([{ status: 201, body: capturedOrder(id) }]);
  const held = paypal.hold();
  const results = Promise.all([
    a.registry.capture(id, paypal.runCapture(id)),
    b.registry.capture(id, paypal.runCapture(id)),
  ]);

  // One instance is talking to PayPal; the other must be blocked on the lock.
  await held.reached;
  await waitFor(
    "the other instance to wait for the capture lock",
    async () => (await lockWaiters(db, [a.name, b.name])) === 1,
  );
  held.release();

  const [fromA, fromB] = await results;
  assertPaid(fromA);
  assertPaid(fromB);
  assert.deepEqual(fromA, fromB);
  assertPaid(await b.registry.get(id));
  assert.equal(paypal.captureCalls(), 1);
  assert.deepEqual(paypal.captureRequestIds(), [captureRequestId(id)]);
});

for (const retry of [
  {
    status: "PENDING",
    first: (id: string): PayPalStep[] => [{ status: 201, body: capturedOrder(id, "PENDING") }],
    second: (id: string): PayPalStep[] => [{ status: 201, body: capturedOrder(id) }],
  },
  {
    status: "UNKNOWN",
    // The capture and the follow-up lookup both time out.
    first: (): PayPalStep[] => [timeout(), timeout()],
    // PayPal reports the order as already captured, so it is looked up.
    second: (id: string): PayPalStep[] => [
      { status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_ALREADY_CAPTURED" }] } },
      { status: 200, body: capturedOrder(id) },
    ],
  },
  {
    status: "FAILED",
    first: (id: string): PayPalStep[] => [{ status: 201, body: capturedOrder(id, "DECLINED") }],
    second: (id: string): PayPalStep[] => [{ status: 201, body: capturedOrder(id) }],
  },
] as const) {
  pgTest(`a ${retry.status} order is captured again by another instance, with the same PayPal-Request-Id`, async (t) => {
    const id = orderId(retry.status);
    const a = await openInstance(t);
    const b = await openInstance(t);
    await a.registry.register(id, EXPECTED);
    const paypal = fakePayPal(retry.first(id));

    const first = await a.registry.capture(id, paypal.runCapture(id));
    assert.equal(first?.status, retry.status);
    assert.equal((await b.registry.get(id))?.status, retry.status);

    paypal.addSteps(...retry.second(id));
    assertPaid(await b.registry.capture(id, paypal.runCapture(id)));

    assert.equal(paypal.captureCalls(), 2);
    assert.deepEqual(paypal.captureRequestIds(), [captureRequestId(id), captureRequestId(id)]);
  });
}

pgTest("a NEEDS_REVIEW order is never captured again", async (t) => {
  const id = orderId("REVIEW");
  const a = await openInstance(t);
  const b = await openInstance(t);
  // Registered for USD 10.00, but PayPal captured USD 5.00.
  await a.registry.register(id, { value: "10.00", currency: "USD" });
  const paypal = fakePayPal([{ status: 201, body: capturedOrder(id) }]);

  const first = await a.registry.capture(id, paypal.runCapture(id));
  assert.equal(first?.status, "NEEDS_REVIEW");
  const second = await b.registry.capture(id, paypal.runCapture(id));
  assert.equal(second?.status, "NEEDS_REVIEW");
  assert.equal(paypal.captureCalls(), 1);
});

pgTest("a failed retry keeps the capture details PayPal reported earlier", async (t) => {
  const id = orderId("KEEP");
  const { registry } = await openInstance(t);
  await registry.register(id, EXPECTED);
  const paypal = fakePayPal([
    { status: 201, body: capturedOrder(id, "PENDING") },
    { status: 400, body: { name: "INVALID_REQUEST" } },
  ]);

  await registry.capture(id, paypal.runCapture(id));
  const retried = await registry.capture(id, paypal.runCapture(id));

  assert.equal(retried?.status, "FAILED");
  assert.equal(retried?.message, "PayPal could not capture this order.");
  assert.equal(retried?.captureStatus, "PENDING");
  assert.equal(retried?.capturedAmount, "5.00");
  assert.equal(retried?.capturedCurrency, "USD");
});

pgTest("if PayPal can't be reached, the order is unchanged and the lock is released", async (t) => {
  const id = orderId("UNREACHABLE");
  const a = await openInstance(t);
  // A short wait limit: if the lock were still held, this capture would fail.
  const b = await openInstance(t, { lockTimeoutMs: 2000 });
  const registered = await a.registry.register(id, EXPECTED);

  await assert.rejects(
    a.registry.capture(id, async () => {
      throw new Error("PayPal authentication failed: HTTP 503");
    }),
    /authentication failed/,
  );
  assert.deepEqual(await b.registry.get(id), registered);

  const paypal = fakePayPal([{ status: 201, body: capturedOrder(id) }]);
  assertPaid(await b.registry.capture(id, paypal.runCapture(id)));
});

pgTest("a capture waiting for another instance gives up after lockTimeoutMs", async (t, db) => {
  const id = orderId("LOCK-TIMEOUT");
  const a = await openInstance(t);
  const b = await openInstance(t, { lockTimeoutMs: 300 });
  await a.registry.register(id, EXPECTED);
  const paypal = fakePayPal([{ status: 201, body: capturedOrder(id) }]);
  const held = paypal.hold();

  const fromA = a.registry.capture(id, paypal.runCapture(id));
  await held.reached;
  await assert.rejects(b.registry.capture(id, paypal.runCapture(id)), /lock timeout/);
  assert.equal(await lockWaiters(db, [b.name]), 0, "the waiter stopped waiting");

  held.release();
  assertPaid(await fromA);
  assert.equal(paypal.captureCalls(), 1);
});

pgTest("losing the database connection mid-capture records nothing and releases the lock", async (t, db) => {
  const id = orderId("CONNECTION-LOST");
  const a = await openInstance(t);
  const b = await openInstance(t, { lockTimeoutMs: 5000 });
  const registered = await a.registry.register(id, EXPECTED);
  const paypal = fakePayPal([{ status: 201, body: capturedOrder(id) }]);
  const held = paypal.hold();

  const fromA = a.registry.capture(id, paypal.runCapture(id));
  await held.reached;
  const terminated = await db.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE application_name = $1 AND state = 'idle in transaction'`,
    [a.name],
  );
  assert.equal(terminated.rowCount, 1, "the capturing session was found and ended");
  await waitFor("the session to end", async () => (await sessionsInTransaction(db, a.name)) === 0);

  // PayPal captured the payment, but the database connection is gone, so the
  // result can't be recorded: the capture fails rather than claiming success.
  held.release();
  await assert.rejects(fromA, CONNECTION_LOST);
  assert.deepEqual(await b.registry.get(id), registered, "nothing was recorded");

  // Another instance can capture at once; the same PayPal-Request-Id returns
  // PayPal's earlier result instead of charging again.
  paypal.addSteps({ status: 201, body: capturedOrder(id) });
  assertPaid(await b.registry.capture(id, paypal.runCapture(id)));
  assert.deepEqual(paypal.captureRequestIds(), [captureRequestId(id), captureRequestId(id)]);
});

pgTest("PostgreSQL enforces lockHoldTimeoutMs while a capture waits on PayPal, and the late result is not recorded", async (t, db) => {
  const id = orderId("STALLED");
  const holdLimitMs = 1000;
  const a = await openInstance(t, { lockHoldTimeoutMs: holdLimitMs });
  const b = await openInstance(t, { lockTimeoutMs: 5000 });
  await a.registry.register(id, EXPECTED);
  // B's capture answers first (A's answer is held); then A's late answer.
  const paypal = fakePayPal([
    { status: 201, body: capturedOrder(id) },
    { status: 201, body: capturedOrder(id) },
  ]);
  const held = paypal.hold();

  // A is waiting on PayPal with the lock held; B waits for the lock.
  const fromA = a.registry.capture(id, paypal.runCapture(id));
  await held.reached;
  const heldAt = Date.now();
  const fromB = b.registry.capture(id, paypal.runCapture(id));
  await waitFor("B to wait for the lock", async () => (await lockWaiters(db, [b.name])) === 1);
  assert.equal(await sessionsInTransaction(db, a.name), 1, "A still holds the lock before the limit");

  // No query runs in A's session while it waits on PayPal; PostgreSQL ends
  // the session once it has been idle in the transaction for the limit.
  await waitFor(
    "PostgreSQL to end the stalled session",
    async () => (await sessionsInTransaction(db, a.name)) === 0,
  );
  const endedAfterMs = Date.now() - heldAt;
  assert.ok(endedAfterMs >= holdLimitMs - 300, `ended after ${endedAfterMs} ms, not before the limit`);
  assert.ok(endedAfterMs < holdLimitMs + 1500, `ended after ${endedAfterMs} ms, close to the limit`);

  // B gets the lock while A is still stuck, and records the capture.
  assertPaid(await fromB);

  // A's PayPal answer arrives late; A can't record it and says so.
  held.release();
  await assert.rejects(fromA, CONNECTION_LOST);
  assertPaid(await b.registry.get(id));
  assert.deepEqual(paypal.captureRequestIds(), [captureRequestId(id), captureRequestId(id)]);
});

pgTest("closing the registry waits for a capture in progress before ending the pool", async (t) => {
  const id = orderId("CLOSE-DURING-CAPTURE");
  const a = await openInstance(t);
  await a.registry.register(id, EXPECTED);
  const paypal = fakePayPal([{ status: 201, body: capturedOrder(id) }]);
  const held = paypal.hold();
  const events: string[] = [];

  const capture = a.registry.capture(id, paypal.runCapture(id)).then((record) => {
    events.push("capture recorded");
    return record;
  });
  await held.reached;
  const closed = a.registry.close().then(() => events.push("pool ended"));

  await delay(200);
  assert.deepEqual(events, [], "the pool waits while the capture holds its connection");

  held.release();
  assertPaid(await capture);
  await closed;
  assert.deepEqual(events, ["capture recorded", "pool ended"]);

  const b = await openInstance(t);
  assertPaid(await b.registry.get(id));
});

test("the pool waits at most DEFAULT_CONNECTION_TIMEOUT_MS for a connection unless told otherwise", async () => {
  // Building a pool doesn't connect, so this needs no database.
  const pool = createPostgresPool("postgresql://user:password@127.0.0.1:1/none");
  const custom = createPostgresPool("postgresql://user:password@127.0.0.1:1/none", {
    connectionTimeoutMillis: 1234,
  });
  try {
    assert.equal(DEFAULT_CONNECTION_TIMEOUT_MS, 15_000);
    assert.equal(pool.options.connectionTimeoutMillis, DEFAULT_CONNECTION_TIMEOUT_MS);
    assert.equal(custom.options.connectionTimeoutMillis, 1234);
  } finally {
    await Promise.all([pool.end(), custom.end()]);
  }
});

pgTest("when every connection is held by a capture, other requests fail fast instead of hanging", async (t) => {
  const id = orderId("POOL-EXHAUSTED");
  const other = orderId("POOL-EXHAUSTED-OTHER");
  const registry = new PostgresOrderRegistry(
    createPostgresPool(DATABASE_URL, {
      application_name: `${RUN}-pool-exhausted`,
      max: 1,
      connectionTimeoutMillis: 500,
    }),
  );
  t.after(() => registry.close());
  await registry.initialize();
  await registry.register(id, EXPECTED);
  await registry.register(other, EXPECTED);

  const paypal = fakePayPal([{ status: 201, body: capturedOrder(id) }]);
  const held = paypal.hold();
  const capture = registry.capture(id, paypal.runCapture(id));
  await held.reached;

  // The only connection is held while the capture waits on PayPal.
  const startedAt = Date.now();
  await assert.rejects(registry.get(other), /timeout/i);
  const waitedMs = Date.now() - startedAt;
  assert.ok(waitedMs < 3000, `gave up after ${waitedMs} ms`);

  // The capture is unaffected and is recorded once PayPal answers.
  held.release();
  assertPaid(await capture);
  assert.equal((await registry.get(other))?.status, "CREATED");
});

pgTest("a query that runs past the pool's query timeout fails, and the pool keeps working", async (t) => {
  const pool = createPostgresPool(DATABASE_URL, {
    application_name: `${RUN}-query-timeout`,
    max: 1,
    query_timeout: 300,
  });
  t.after(() => pool.end());
  const defaults = createPostgresPool("postgresql://u:p@127.0.0.1:1/x");
  t.after(() => defaults.end());
  assert.equal(defaults.options.query_timeout, DEFAULT_QUERY_TIMEOUT_MS);

  const startedAt = Date.now();
  await assert.rejects(pool.query("SELECT pg_sleep(3)"), /Query read timeout/);
  assert.ok(Date.now() - startedAt < 2000, "gave up near the timeout");

  // The timed-out connection was discarded; the next query gets a fresh one.
  const result = await pool.query<{ ok: number }>("SELECT 1 AS ok");
  assert.equal(result.rows[0]?.ok, 1);
});

pgTest("waiting for another instance's capture lock may outlast the pool's query timeout", async (t) => {
  const id = orderId("LOCK-WAIT-LONGER-THAN-QUERY-TIMEOUT");
  const open = async () => {
    const name = `${RUN}-instance-${++counter}`;
    const registry = new PostgresOrderRegistry(
      createPostgresPool(DATABASE_URL, { application_name: name, max: 2, query_timeout: 300 }),
      { lockTimeoutMs: 5000 },
    );
    t.after(() => registry.close());
    await registry.initialize();
    return { registry, name };
  };
  const a = await open();
  const b = await open();
  await a.registry.register(id, EXPECTED);

  const paypal = fakePayPal([{ status: 201, body: capturedOrder(id) }]);
  const held = paypal.hold();
  const fromA = a.registry.capture(id, paypal.runCapture(id));
  await held.reached;

  const fromB = b.registry.capture(id, paypal.runCapture(id));
  await waitFor("B to wait for the lock", async () => (await lockWaiters(admin!, [b.name])) > 0);
  await delay(800); // B has now waited longer than the 300 ms query timeout.

  held.release();
  assertPaid(await fromA);
  assertPaid(await fromB);
  assert.equal(paypal.captureCalls(), 1);
});

pgTest("the checkout token hash is stored at registration and never replaced", async (t) => {
  const id = orderId("TOKEN-HASH");
  const a = await openInstance(t);
  await a.registry.register(id, EXPECTED, "a".repeat(64));
  await a.registry.register(id, EXPECTED, "b".repeat(64));
  const b = await openInstance(t);
  assert.equal((await b.registry.get(id))?.checkoutTokenHash, "a".repeat(64));
});

pgTest("a capture before buyer approval sends no capture request and leaves the order capturable", async (t) => {
  const id = orderId("NOT-APPROVED");
  const a = await openInstance(t);
  await a.registry.register(id, EXPECTED);
  const paypal = fakePayPal([{ status: 201, body: capturedOrder(id) }]);

  paypal.setApprovalStatus("CREATED");
  const early = await a.registry.capture(id, paypal.runCapture(id));
  assert.equal(early?.status, "CREATED");
  assert.equal(early?.orderStatus, "CREATED");
  assert.equal(paypal.captureCalls(), 0);

  // Another instance captures once the buyer has approved.
  paypal.setApprovalStatus("APPROVED");
  const b = await openInstance(t);
  assertPaid(await b.registry.capture(id, paypal.runCapture(id)));
  assert.deepEqual(paypal.captureRequestIds(), [captureRequestId(id)]);
});

pgTest("upgrading a table created before checkout tokens adds the column and keeps its orders", async (t, db) => {
  // A private schema with the version 1 table, dropped afterwards. Nothing
  // outside it is read or changed.
  const schema = `itest_${RUN.slice(6).toLowerCase()}_legacy`;
  await db.query(`CREATE SCHEMA ${schema}`);
  t.after(() => db.query(`DROP SCHEMA ${schema} CASCADE`));
  await db.query(`
    CREATE TABLE ${schema}.paypal_orders (
      order_id TEXT PRIMARY KEY, expected_amount TEXT NOT NULL, expected_currency TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
      payment_status TEXT NOT NULL, order_status TEXT, capture_status TEXT,
      captured_amount TEXT, captured_currency TEXT, message TEXT
    );
    INSERT INTO ${schema}.paypal_orders VALUES ('LEGACY1', '5.00', 'USD', NOW(), NOW(), 'PAID', 'COMPLETED', 'COMPLETED', '5.00', 'USD', NULL);
  `);

  const registry = new PostgresOrderRegistry(
    createPostgresPool(DATABASE_URL, { application_name: `${RUN}-legacy`, max: 2, options: `-c search_path=${schema}` }),
  );
  t.after(() => registry.close());
  await registry.initialize();
  await registry.initialize();

  const legacy = await registry.get("LEGACY1");
  assert.equal(legacy?.status, "PAID", "existing orders are kept");
  assert.equal(legacy?.checkoutTokenHash, null, "older orders have no token, so the API refuses them");
  const columns = await db.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'paypal_orders' AND column_name = 'checkout_token_hash'`,
    [schema],
  );
  assert.equal(columns.rowCount, 1);
});
