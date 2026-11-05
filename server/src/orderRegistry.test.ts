// Tests for the order registry and the capture/status routes. The routes run
// on a local test server; PayPal is mocked, so no credentials, network calls
// to PayPal, or real payments are involved.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { OrderRegistry, isValidOrderID } from "./orderRegistry.js";
import { createPaymentRouter, type RunCapture } from "./paymentRoutes.js";
import { capturePayPalOrder, type ExpectedAmount } from "./paypalCapture.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";


const ORDER_ID = "5O190127TN364715T";
const EXPECTED: ExpectedAmount = { value: "5.00", currency: "USD" };
const silentLogger = { log() {}, error() {} };

type PayPalStep = { status: number; body: unknown } | { throws: unknown };

function capturedOrder(status = "COMPLETED", value = "5.00", currency = "USD") {
  return {
    id: ORDER_ID,
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

const timeout = () => ({
  throws: new DOMException("The operation timed out.", "TimeoutError"),
});

// Runs the real capture logic against scripted PayPal responses.
function mockPayPal(steps: PayPalStep[]) {
  let requests = 0;
  const runCapture: RunCapture = (orderID, expected) =>
    capturePayPalOrder(orderID, expected, {
      baseUrl: "https://paypal.test",
      accessToken: "fake-access-token-for-tests",
      logger: silentLogger,
      fetch: async () => {
        requests++;
        const step = steps.shift();
        if (!step) throw new Error("Unexpected extra PayPal request");
        if ("throws" in step) throw step.throws;
        // Slow PayPal down slightly so concurrent requests overlap.
        await new Promise((resolve) => setTimeout(resolve, 20));
        return new Response(JSON.stringify(step.body), { status: step.status });
      },
    });
  return {
    runCapture,
    requests: () => requests,
    addSteps: (...more: PayPalStep[]) => steps.push(...more),
  };
}

async function startApi(t: TestContext, registry: OrderRegistry, runCapture: RunCapture) {
  const app = express();
  app.use(express.json());
  app.use(createPaymentRouter(registry, runCapture));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/payments`;
  const call = async (path: string, init?: RequestInit) => {
    const response = await fetch(`${base}${path}`, init);
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  };

  return {
    capture: (orderID: unknown) =>
      call("/capture-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderID }),
      }),
    status: (orderID: string) => call(`/orders/${encodeURIComponent(orderID)}`),
  };
}

function registryWithOrder(expected = EXPECTED) {
  const registry = new OrderRegistry();
  registry.register(ORDER_ID, expected);
  return registry;
}

test("registering an order records the expected amount, currency, time, and status", () => {
  const createdAt = new Date("2026-10-24T12:00:00Z");
  const registry = new OrderRegistry({ now: () => createdAt });

  registry.register(ORDER_ID, EXPECTED);

  assert.deepEqual(registry.get(ORDER_ID), {
    orderID: ORDER_ID,
    expected: EXPECTED,
    createdAt,
    updatedAt: createdAt,
    status: "CREATED",
    orderStatus: null,
    captureStatus: null,
    capturedAmount: null,
    capturedCurrency: null,
    message: null,
  });
});

test("the registry preserves older unpaid orders", () => {
  const registry = new OrderRegistry();

  registry.register("ORDER1", EXPECTED);
  registry.register("ORDER2", EXPECTED);
  registry.register("ORDER3", EXPECTED);

  assert.ok(registry.get("ORDER1"));
  assert.ok(registry.get("ORDER2"));
  assert.ok(registry.get("ORDER3"));

  registry.close();
});
test("order ID validation accepts PayPal IDs and rejects anything else", () => {
  assert.equal(isValidOrderID(ORDER_ID), true);
  for (const bad of ["", "bad id", "../secret", "A".repeat(101), 42, null]) {
    assert.equal(isValidOrderID(bad), false, `rejects ${String(bad)}`);
  }
});

test("status lookup returns the known status without buyer data", async (t) => {
  const api = await startApi(t, registryWithOrder(), mockPayPal([]).runCapture);

  const { status, body } = await api.status(ORDER_ID);

  assert.equal(status, 200);
  assert.equal(body.paymentStatus, "CREATED");
  assert.equal(body.paid, false);
  assert.equal(body.expectedAmount, "5.00");
  assert.equal(body.expectedCurrency, "USD");
  assert.equal(typeof body.createdAt, "string");
  assert.equal(body.amount, null);
  assert.equal("payer" in body, false);
});

test("unknown order IDs get a safe 404 and never reach PayPal", async (t) => {
  const paypal = mockPayPal([]);
  const api = await startApi(t, registryWithOrder(), paypal.runCapture);

  const lookup = await api.status("8XY12345AB678901C");
  const capture = await api.capture("8XY12345AB678901C");

  assert.equal(lookup.status, 404);
  assert.equal(capture.status, 404);
  assert.match(String(capture.body.error), /not known to the server/);
  assert.equal(paypal.requests(), 0);
});

test("malformed order IDs are rejected with 400", async (t) => {
  const paypal = mockPayPal([]);
  const api = await startApi(t, registryWithOrder(), paypal.runCapture);

  assert.equal((await api.status("bad id!")).status, 400);
  assert.equal((await api.capture("bad id!")).status, 400);
  assert.equal((await api.capture(undefined)).status, 400);
  assert.equal(paypal.requests(), 0);
});

test("a verified capture marks the order paid, and repeat checks never call PayPal again", async (t) => {
  const paypal = mockPayPal([{ status: 201, body: capturedOrder() }]);
  const api = await startApi(t, registryWithOrder(), paypal.runCapture);

  const capture = await api.capture(ORDER_ID);
  assert.equal(capture.status, 200);
  assert.equal(capture.body.paymentStatus, "PAID");
  assert.equal(capture.body.paid, true);
  assert.equal(capture.body.captureStatus, "COMPLETED");
  assert.equal(capture.body.amount, "5.00");
  assert.equal(capture.body.currency, "USD");
  assert.equal("payer" in capture.body, false);

  const firstLookup = await api.status(ORDER_ID);
  const repeatCapture = await api.capture(ORDER_ID);
  const secondLookup = await api.status(ORDER_ID);

  assert.equal(firstLookup.body.paymentStatus, "PAID");
  assert.deepEqual(repeatCapture.body, capture.body);
  assert.deepEqual(secondLookup.body, firstLookup.body);
  assert.equal(paypal.requests(), 1, "PayPal was called once in total");
});

test("a capture that doesn't match the registered amount is never paid", async (t) => {
  // The order was registered for USD 10.00, but PayPal captured USD 5.00.
  const paypal = mockPayPal([{ status: 201, body: capturedOrder() }]);
  const api = await startApi(
    t,
    registryWithOrder({ value: "10.00", currency: "USD" }),
    paypal.runCapture,
  );

  const capture = await api.capture(ORDER_ID);
  const repeat = await api.capture(ORDER_ID);

  assert.equal(capture.body.paymentStatus, "NEEDS_REVIEW");
  assert.equal(capture.body.paid, false);
  assert.equal(repeat.body.paymentStatus, "NEEDS_REVIEW");
  assert.equal(paypal.requests(), 1, "needs-review orders are not re-sent to PayPal");
  assert.equal((await api.status(ORDER_ID)).body.paid, false);
});

for (const [captureStatus, paymentStatus] of [
  ["DECLINED", "FAILED"],
  ["FAILED", "FAILED"],
  ["PENDING", "PENDING"],
] as const) {
  test(`a ${captureStatus} capture is recorded as ${paymentStatus}, not paid`, async (t) => {
    const paypal = mockPayPal([{ status: 201, body: capturedOrder(captureStatus) }]);
    const api = await startApi(t, registryWithOrder(), paypal.runCapture);

    const capture = await api.capture(ORDER_ID);
    const lookup = await api.status(ORDER_ID);

    assert.equal(capture.body.paymentStatus, paymentStatus);
    assert.equal(capture.body.paid, false);
    assert.equal(typeof capture.body.message, "string");
    assert.equal(lookup.body.paymentStatus, paymentStatus);
  });
}

test("a pending capture can be checked again and becomes paid when PayPal completes it", async (t) => {
  const paypal = mockPayPal([{ status: 201, body: capturedOrder("PENDING") }]);
  const api = await startApi(t, registryWithOrder(), paypal.runCapture);

  assert.equal((await api.capture(ORDER_ID)).body.paymentStatus, "PENDING");

  // PayPal answers the repeated PayPal-Request-Id with the capture's latest state.
  paypal.addSteps({ status: 201, body: capturedOrder("COMPLETED") });
  const recheck = await api.capture(ORDER_ID);

  assert.equal(recheck.body.paymentStatus, "PAID");
  assert.equal(paypal.requests(), 2);
});

test("an unclear result is UNKNOWN, and checking again on the same order can confirm it", async (t) => {
  // Capture times out and the follow-up order lookup fails too.
  const paypal = mockPayPal([timeout(), timeout()]);
  const api = await startApi(t, registryWithOrder(), paypal.runCapture);

  const first = await api.capture(ORDER_ID);
  assert.equal(first.status, 200);
  assert.equal(first.body.paymentStatus, "UNKNOWN");
  assert.equal(first.body.paid, false);
  assert.match(String(first.body.message), /will not charge twice/);
  assert.equal((await api.status(ORDER_ID)).body.paymentStatus, "UNKNOWN");

  // Checking again: PayPal reports the order was already captured, so the
  // backend looks it up instead of capturing again.
  paypal.addSteps(
    {
      status: 422,
      body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_ALREADY_CAPTURED" }] },
    },
    { status: 200, body: capturedOrder() },
  );
  const second = await api.capture(ORDER_ID);

  assert.equal(second.body.paymentStatus, "PAID");
  assert.equal(second.body.orderID, ORDER_ID);
});

test("if PayPal can't be reached before capture, the order is left unchanged", async (t) => {
  const failingCapture: RunCapture = async () => {
    throw new Error("PayPal authentication failed: HTTP 503");
  };
  const api = await startApi(t, registryWithOrder(), failingCapture);
  t.mock.method(console, "error", () => {});

  const capture = await api.capture(ORDER_ID);

  assert.equal(capture.status, 502);
  assert.equal((await api.status(ORDER_ID)).body.paymentStatus, "CREATED");
});

test("simultaneous capture requests for one order share a single PayPal call", async (t) => {
  const paypal = mockPayPal([{ status: 201, body: capturedOrder() }]);
  const api = await startApi(t, registryWithOrder(), paypal.runCapture);

  const results = await Promise.all([api.capture(ORDER_ID), api.capture(ORDER_ID)]);

  assert.deepEqual(
    results.map((r) => r.body.paymentStatus),
    ["PAID", "PAID"],
  );
  assert.equal(paypal.requests(), 1);
});
test("registered orders persist after the registry is reopened", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paypilot-test-"));
  const dbPath = path.join(tempDir, "paypilot.db");

  try {
    const firstRegistry = new OrderRegistry({ filename: dbPath });

    firstRegistry.register("PERSIST-ORDER-1", EXPECTED);
    firstRegistry.close();

    const secondRegistry = new OrderRegistry({ filename: dbPath });

    const restored = secondRegistry.get("PERSIST-ORDER-1");

    assert.ok(restored);
    assert.equal(restored.orderID, "PERSIST-ORDER-1");
    assert.equal(restored.expected.value, "5.00");
    assert.equal(restored.expected.currency, "USD");
    assert.equal(restored.status, "CREATED");

    secondRegistry.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});