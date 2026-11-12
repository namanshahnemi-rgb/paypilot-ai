// SQLite order registry, used by the unit tests (in memory). The backend
// uses the PostgreSQL registry in postgresOrderRegistry.ts; both implement
// OrderRegistryPort from orderModel.ts and record capture results the same
// way (captureUpdate).
import type Database from "better-sqlite3";
import { openDatabase } from "./database.js";
import type { CaptureResult, ExpectedAmount } from "./paypalCapture.js";
import {
  FINAL_STATUSES,
  captureUpdate,
  type OrderRecord,
  type OrderRegistryPort,
  type PaymentStatus,
} from "./orderModel.js";

// Re-exported so existing imports from this module keep working.
export {
  isValidOrderID,
  toOrderView,
  type OrderRecord,
  type OrderRegistryPort,
  type PaymentStatus,
} from "./orderModel.js";

type RegistryOptions = {
  now?: () => Date;
  filename?: string;
};

type OrderRow = {
  order_id: string;
  expected_amount: string;
  expected_currency: string;
  created_at: string;
  updated_at: string;
  payment_status: PaymentStatus;
  order_status: string | null;
  capture_status: string | null;
  captured_amount: string | null;
  captured_currency: string | null;
  message: string | null;
  checkout_token_hash: string | null;
};

export class OrderRegistry implements OrderRegistryPort {
  private readonly db: Database.Database;
  private readonly now: () => Date;
  private readonly capturesInFlight = new Map<
    string,
    Promise<OrderRecord | undefined>
  >();

  private readonly findOrder;
  private readonly insertOrder;
  private readonly updateOrder;

  constructor(options: RegistryOptions = {}) {
    this.now = options.now ?? (() => new Date());

    this.db = openDatabase({
      filename: options.filename ?? ":memory:",
    });

    this.findOrder = this.db.prepare(`
      SELECT * FROM paypal_orders WHERE order_id = ?
    `);

    this.insertOrder = this.db.prepare(`
      INSERT OR IGNORE INTO paypal_orders (
        order_id,
        expected_amount,
        expected_currency,
        created_at,
        updated_at,
        payment_status,
        order_status,
        capture_status,
        captured_amount,
        captured_currency,
        message,
        checkout_token_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.updateOrder = this.db.prepare(`
      UPDATE paypal_orders SET
        updated_at = ?,
        payment_status = ?,
        order_status = ?,
        capture_status = ?,
        captured_amount = ?,
        captured_currency = ?,
        message = ?
      WHERE order_id = ?
    `);
  }

  private fromRow(row: OrderRow): OrderRecord {
    return {
      orderID: row.order_id,
      expected: {
        value: row.expected_amount,
        currency: row.expected_currency,
      },
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      status: row.payment_status,
      orderStatus: row.order_status,
      captureStatus: row.capture_status,
      capturedAmount: row.captured_amount,
      capturedCurrency: row.captured_currency,
      message: row.message,
      checkoutTokenHash: row.checkout_token_hash,
    };
  }

  // Registering an order that already exists changes nothing, including its
  // checkout token hash.
  async register(
    orderID: string,
    expected: ExpectedAmount,
    checkoutTokenHash: string | null = null,
  ): Promise<OrderRecord> {
    const now = this.now();

    this.insertOrder.run(
      orderID,
      expected.value,
      expected.currency,
      now.toISOString(),
      now.toISOString(),
      "CREATED",
      null,
      null,
      null,
      null,
      null,
      checkoutTokenHash,
    );

    const record = await this.get(orderID);

    if (!record) {
      throw new Error("Order registration could not be confirmed.");
    }

    return record;
  }

  async get(orderID: string): Promise<OrderRecord | undefined> {
    const row = this.findOrder.get(orderID) as OrderRow | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  async capture(
    orderID: string,
    runCapture: (expected: ExpectedAmount) => Promise<CaptureResult>,
  ): Promise<OrderRecord | undefined> {
    const existing = this.capturesInFlight.get(orderID);
    if (existing) return existing;

    const pending = this.captureOnce(orderID, runCapture).finally(() => {
      this.capturesInFlight.delete(orderID);
    });

    this.capturesInFlight.set(orderID, pending);
    return pending;
  }

  private async captureOnce(
    orderID: string,
    runCapture: (expected: ExpectedAmount) => Promise<CaptureResult>,
  ): Promise<OrderRecord | undefined> {
    const record = await this.get(orderID);
    if (!record) return undefined;

    if (FINAL_STATUSES.has(record.status)) return record;

    const result = await runCapture(record.expected);
    const update = captureUpdate(result, record);

    this.updateOrder.run(
      this.now().toISOString(),
      update.status,
      update.orderStatus,
      update.captureStatus,
      update.amount,
      update.currency,
      update.message,
      orderID,
    );

    const updated = await this.get(orderID);

    if (!updated) {
      throw new Error("Order disappeared while recording capture.");
    }

    return updated;
  }

  close(): void {
    this.db.close();
  }
}
