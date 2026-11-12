// PostgreSQL order registry used by the backend (DATABASE_URL). Capture
// attempts for one order are serialized across backend instances with a
// transaction-scoped advisory lock; the SQLite registry in orderRegistry.ts
// implements the same OrderRegistryPort for unit tests.
import pg, { type Pool, type PoolClient, type PoolConfig } from "pg";
import type {
  CaptureResult,
  ExpectedAmount,
} from "./paypalCapture.js";
import {
  FINAL_STATUSES,
  captureUpdate,
  type OrderRecord,
  type OrderRegistryPort,
  type PaymentStatus,
} from "./orderModel.js";

// How long a request waits for a pooled connection (a new connection, or a
// free one when all are in use) before failing. pg waits forever by default,
// so a database outage, or every connection being held by captures waiting
// on PayPal, would leave every request hanging. Long enough for a serverless
// database such as Neon to wake up.
export const DEFAULT_CONNECTION_TIMEOUT_MS = 15_000;

// How long any single query may run before the client gives up on it (pg's
// query_timeout). A silently dropped network connection would otherwise
// leave a query waiting for minutes. The pool discards a connection whose
// query failed, so it is never reused. The capture's lock wait gets its own,
// longer limit.
export const DEFAULT_QUERY_TIMEOUT_MS = 20_000;

// Creates the connection pool for a DATABASE_URL. Errors on idle connections
// (for example, the database restarting) are logged by message only, never
// with the connection string, instead of crashing the process.
export function createPostgresPool(
  connectionString: string,
  config: Omit<PoolConfig, "connectionString"> = {},
): Pool {
  const pool = new pg.Pool({
    connectionTimeoutMillis: DEFAULT_CONNECTION_TIMEOUT_MS,
    query_timeout: DEFAULT_QUERY_TIMEOUT_MS,
    // Notice connections that dropped silently (for example, while a
    // serverless database scaled to zero) instead of waiting on them.
    keepAlive: true,
    ...config,
    connectionString,
  });
  pool.on("error", (error) => {
    console.error("PostgreSQL connection error:", error.message);
  });
  return pool;
}

export type PostgresRegistryOptions = {
  // How long a capture waits for another instance's capture of the same
  // order before giving up with an error (the client can retry).
  lockTimeoutMs?: number;
  // How long a capture may hold the lock while waiting on PayPal. This is
  // enforced by PostgreSQL itself (idle_in_transaction_session_timeout): the
  // wait for PayPal is time the transaction sits idle, so once it passes this
  // limit PostgreSQL ends the session, which rolls back and releases the
  // lock even if this process is stuck. The capture then fails when it tries
  // to record the result, so nothing is recorded as paid.
  lockHoldTimeoutMs?: number;
};

// A capture makes at most four PayPal requests: the access token (15 s
// timeout), the order check before capturing (10 s), the capture (15 s), and
// an order lookup if the capture's result is unclear (10 s). A healthy
// capture holds the lock for under 50 seconds, so the hold limit never cuts
// one short. Waiters wait longer than a holder can hold.
const DEFAULT_LOCK_HOLD_TIMEOUT_MS = 60_000;
const DEFAULT_LOCK_TIMEOUT_MS = 75_000;

type OrderRow = {
  order_id: string;
  expected_amount: string;
  expected_currency: string;
  created_at: Date | string;
  updated_at: Date | string;
  payment_status: PaymentStatus;
  order_status: string | null;
  capture_status: string | null;
  captured_amount: string | null;
  captured_currency: string | null;
  message: string | null;
  checkout_token_hash: string | null;
};

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function fromRow(row: OrderRow): OrderRecord {
  return {
    orderID: row.order_id,
    expected: {
      value: row.expected_amount,
      currency: row.expected_currency,
    },
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
    status: row.payment_status,
    orderStatus: row.order_status,
    captureStatus: row.capture_status,
    capturedAmount: row.captured_amount,
    capturedCurrency: row.captured_currency,
    message: row.message,
    checkoutTokenHash: row.checkout_token_hash,
  };
}

// pg rejects a query that passed query_timeout with this message. The
// query may still be running on that connection, so it is discarded rather
// than used for a ROLLBACK that would wait behind it.
function isQueryTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === "Query read timeout";
}

export class PostgresOrderRegistry implements OrderRegistryPort {
  private readonly capturesInFlight =
    new Map<string, Promise<OrderRecord | undefined>>();
  private readonly lockTimeoutMs: number;
  private readonly lockHoldTimeoutMs: number;
  private closing: Promise<void> | undefined;

  constructor(
    private readonly pool: Pool,
    options: PostgresRegistryOptions = {},
  ) {
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.lockHoldTimeoutMs =
      options.lockHoldTimeoutMs ?? DEFAULT_LOCK_HOLD_TIMEOUT_MS;
  }

  // Creates or updates the schema. Safe to run from several instances at
  // once: it runs in one transaction that first takes a schema lock, because
  // concurrent CREATE TABLE IF NOT EXISTS can fail. Lock waits are bounded,
  // so an instance starting while captures hold row locks fails its startup
  // (and the platform retries it) instead of queueing an ALTER TABLE that
  // would block every payment query behind it.
  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    let failure: Error | undefined;
    try {
      await client.query("BEGIN");
      await client.query(
        `SELECT
           set_config('lock_timeout', '10s', true),
           set_config('statement_timeout', '30s', true)`,
      );
      await client.query(`
        SELECT pg_advisory_xact_lock(hashtextextended('paypilot:schema', 0));

        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL
        );

        CREATE TABLE IF NOT EXISTS paypal_orders (
          order_id TEXT PRIMARY KEY,
          expected_amount TEXT NOT NULL,
          expected_currency TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL,
          payment_status TEXT NOT NULL CHECK (
            payment_status IN (
              'CREATED',
              'PAID',
              'PENDING',
              'FAILED',
              'NEEDS_REVIEW',
              'UNKNOWN'
            )
          ),
          order_status TEXT,
          capture_status TEXT,
          captured_amount TEXT,
          captured_currency TEXT,
          message TEXT,
          checkout_token_hash TEXT
        );

        -- Version 2: checkout tokens. ALTER TABLE takes an exclusive lock
        -- even with IF NOT EXISTS, so it runs only when the column is missing.
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'paypal_orders'
              AND column_name = 'checkout_token_hash'
          ) THEN
            ALTER TABLE paypal_orders ADD COLUMN checkout_token_hash TEXT;
          END IF;
        END
        $$;

        CREATE INDEX IF NOT EXISTS idx_paypal_orders_status
          ON paypal_orders(payment_status);

        CREATE INDEX IF NOT EXISTS idx_paypal_orders_created_at
          ON paypal_orders(created_at);

        INSERT INTO schema_migrations (version, applied_at)
        VALUES (1, NOW()), (2, NOW())
        ON CONFLICT (version) DO NOTHING;
      `);
      await client.query("COMMIT");
    } catch (error) {
      failure = error instanceof Error ? error : new Error("Schema setup failed.");
      if (!isQueryTimeout(error)) {
        await client.query("ROLLBACK").catch(() => undefined);
      }
      throw error;
    } finally {
      // A connection whose transaction failed is discarded, not reused.
      client.release(failure);
    }
  }

  // Registering an order that already exists changes nothing, including its
  // checkout token hash.
  async register(
    orderID: string,
    expected: ExpectedAmount,
    checkoutTokenHash: string | null = null,
  ): Promise<OrderRecord> {
    const now = new Date();

    const inserted = await this.pool.query<OrderRow>(
      `
        INSERT INTO paypal_orders (
          order_id,
          expected_amount,
          expected_currency,
          created_at,
          updated_at,
          payment_status,
          checkout_token_hash
        )
        VALUES ($1, $2, $3, $4, $4, 'CREATED', $5)
        ON CONFLICT (order_id) DO NOTHING
        RETURNING *
      `,
      [orderID, expected.value, expected.currency, now, checkoutTokenHash],
    );

    if (inserted.rows[0]) {
      return fromRow(inserted.rows[0]);
    }

    const existing = await this.get(orderID);

    if (!existing) {
      throw new Error("Order registration could not be confirmed.");
    }

    return existing;
  }

  async get(orderID: string): Promise<OrderRecord | undefined> {
    const result = await this.pool.query<OrderRow>(
      "SELECT * FROM paypal_orders WHERE order_id = $1",
      [orderID],
    );

    const row = result.rows[0];
    return row ? fromRow(row) : undefined;
  }

  async capture(
    orderID: string,
    runCapture: (expected: ExpectedAmount) => Promise<CaptureResult>,
  ): Promise<OrderRecord | undefined> {
    const inFlight = this.capturesInFlight.get(orderID);
    if (inFlight) return inFlight;

    const pending = this.captureWithLock(orderID, runCapture)
      .finally(() => {
        this.capturesInFlight.delete(orderID);
      });

    this.capturesInFlight.set(orderID, pending);
    return pending;
  }

  private async captureWithLock(
    orderID: string,
    runCapture: (expected: ExpectedAmount) => Promise<CaptureResult>,
  ): Promise<OrderRecord | undefined> {
    const client: PoolClient = await this.pool.connect();

    let transactionOpen = false;
    // Set when the connection can't be trusted any more, so the pool
    // discards it instead of handing out a client in a broken transaction.
    let discardClient: Error | undefined;
    // The pool stops listening for errors on a client while it is checked
    // out. If the connection drops while this capture waits on PayPal (for
    // example, when the lock-hold limit ends the session), the client emits
    // "error"; without a listener that would crash the process. The next
    // query on the client then fails, so nothing more is recorded.
    let connectionLost: Error | undefined;
    const onConnectionError = (error: Error) => {
      connectionLost = error;
      discardClient = error;
    };
    client.on("error", onConnectionError);

    try {
      await client.query("BEGIN");
      transactionOpen = true;

      // Both settings last only for this transaction: give up waiting for
      // another instance's lock after lockTimeoutMs, and let PostgreSQL end
      // this session if it sits in the transaction past lockHoldTimeoutMs.
      await client.query(
        `SELECT
           set_config('lock_timeout', $1, true),
           set_config('idle_in_transaction_session_timeout', $2, true)`,
        [`${this.lockTimeoutMs}ms`, `${this.lockHoldTimeoutMs}ms`],
      );

      // Serialize capture attempts across separate backend instances.
      // The transaction-scoped lock is automatically released on commit,
      // rollback, or connection loss. Waiting may take up to lockTimeoutMs,
      // longer than the pool's per-query timeout, so this query has its own.
      // (pg reads query_timeout from the query config; its type definitions
      // don't list it.)
      const lockQuery: pg.QueryConfig & { query_timeout: number } = {
        text: "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        values: [orderID],
        query_timeout: this.lockTimeoutMs + 5_000,
      };
      await client.query(lockQuery);

      const lookup = await client.query<OrderRow>(
        "SELECT * FROM paypal_orders WHERE order_id = $1 FOR UPDATE",
        [orderID],
      );

      const row = lookup.rows[0];

      if (!row) {
        await client.query("COMMIT");
        transactionOpen = false;
        return undefined;
      }

      const record = fromRow(row);

      if (FINAL_STATUSES.has(record.status)) {
        await client.query("COMMIT");
        transactionOpen = false;
        return record;
      }

      // Keep the transaction and advisory lock open until the PayPal
      // response has been recorded. Other instances must wait. If the lock
      // is lost anyway (connection loss, timeout), the stable
      // PayPal-Request-Id keeps a second capture call from charging twice,
      // and this transaction's update fails instead of being recorded.
      const result = await runCapture(record.expected);
      const update = captureUpdate(result, record);

      const updated = await client.query<OrderRow>(
        `
          UPDATE paypal_orders
          SET
            updated_at = $1,
            payment_status = $2,
            order_status = $3,
            capture_status = $4,
            captured_amount = $5,
            captured_currency = $6,
            message = $7
          WHERE order_id = $8
          RETURNING *
        `,
        [
          new Date(),
          update.status,
          update.orderStatus,
          update.captureStatus,
          update.amount,
          update.currency,
          update.message,
          orderID,
        ],
      );

      if (!updated.rows[0]) {
        throw new Error("Order disappeared while recording capture.");
      }

      await client.query("COMMIT");
      transactionOpen = false;

      return fromRow(updated.rows[0]);
    } catch (error) {
      if (isQueryTimeout(error)) {
        // The timed-out query may still hold this connection; discarding it
        // ends the session, which rolls the transaction back and releases
        // the lock.
        discardClient = error as Error;
      } else if (transactionOpen) {
        await client.query("ROLLBACK").catch((rollbackError: unknown) => {
          discardClient =
            rollbackError instanceof Error
              ? rollbackError
              : new Error("Rollback failed.");
        });
      }

      if (connectionLost) {
        // Worded to stay true even if the connection dropped during COMMIT,
        // when PostgreSQL may have saved the result.
        throw new Error(
          `The database connection was lost during the capture (${connectionLost.message}), so the result was not confirmed. Checking the order again is safe and will not charge twice.`,
          { cause: error },
        );
      }

      throw error;
    } finally {
      client.off("error", onConnectionError);
      client.release(discardClient);
    }
  }

  // Ends the pool once; later calls wait for the same shutdown.
  close(): Promise<void> {
    this.closing ??= this.pool.end();
    return this.closing;
  }
}
