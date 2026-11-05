
import type Database from "better-sqlite3";
import { openDatabase } from "./database.js";
import type { CaptureResult, ExpectedAmount } from "./paypalCapture.js";

export type PaymentStatus =
  | "CREATED"
  | "PAID"
  | "PENDING"
  | "FAILED"
  | "NEEDS_REVIEW"
  | "UNKNOWN";

export type OrderRecord = {
  orderID: string;
  expected: ExpectedAmount;
  createdAt: Date;
  updatedAt: Date;
  status: PaymentStatus;
  orderStatus: string | null;
  captureStatus: string | null;
  capturedAmount: string | null;
  capturedCurrency: string | null;
  message: string | null;
};

export function isValidOrderID(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z0-9-]{1,100}$/i.test(value);
}

const UNKNOWN_MESSAGE =
  "Could not confirm the payment status with PayPal. Check again in a moment; this will not charge twice.";

const FINAL_STATUSES = new Set<PaymentStatus>(["PAID", "NEEDS_REVIEW"]);

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
};

export class OrderRegistry {
  private readonly db: Database.Database;
  private readonly now: () => Date;
  private readonly capturesInFlight = new Map<string, Promise<OrderRecord>>();

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
      INSERT INTO paypal_orders (
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
        message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(order_id) DO UPDATE SET
        expected_amount = excluded.expected_amount,
        expected_currency = excluded.expected_currency,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        payment_status = excluded.payment_status,
        order_status = excluded.order_status,
        capture_status = excluded.capture_status,
        captured_amount = excluded.captured_amount,
        captured_currency = excluded.captured_currency,
        message = excluded.message
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
    };
  }

  register(orderID: string, expected: ExpectedAmount): OrderRecord {
    const existing = this.get(orderID);

    // Never reset an existing order. In particular, never turn a paid order
    // back into CREATED through a repeated registration.
    if (existing) return existing;

    const now = this.now();

    const record: OrderRecord = {
      orderID,
      expected,
      createdAt: now,
      updatedAt: now,
      status: "CREATED",
      orderStatus: null,
      captureStatus: null,
      capturedAmount: null,
      capturedCurrency: null,
      message: null,
    };

    this.insertOrder.run(
      record.orderID,
      record.expected.value,
      record.expected.currency,
      record.createdAt.toISOString(),
      record.updatedAt.toISOString(),
      record.status,
      record.orderStatus,
      record.captureStatus,
      record.capturedAmount,
      record.capturedCurrency,
      record.message,
    );

    return record;
  }

  get(orderID: string): OrderRecord | undefined {
    const row = this.findOrder.get(orderID) as OrderRow | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  async capture(
    orderID: string,
    runCapture: (expected: ExpectedAmount) => Promise<CaptureResult>,
  ): Promise<OrderRecord | undefined> {
    const record = this.get(orderID);
    if (!record) return undefined;

    if (FINAL_STATUSES.has(record.status)) return record;

    const inFlight = this.capturesInFlight.get(orderID);
    if (inFlight) return inFlight;

    const pending = runCapture(record.expected)
      .then((result) => {
        this.applyCaptureResult(orderID, result);
        const updated = this.get(orderID);

        if (!updated) {
          throw new Error("Order disappeared while recording capture.");
        }

        return updated;
      })
      .finally(() => {
        this.capturesInFlight.delete(orderID);
      });

    this.capturesInFlight.set(orderID, pending);
    return pending;
  }

  private applyCaptureResult(
    orderID: string,
    result: CaptureResult,
  ): void {
    const record = this.get(orderID);
    if (!record) return;

    const updatedAt = this.now().toISOString();

    if (!result.ok) {
      const status =
        result.reason === "STATUS_UNKNOWN" ? "UNKNOWN" : "FAILED";

      const message =
        result.reason === "STATUS_UNKNOWN"
          ? UNKNOWN_MESSAGE
          : "PayPal could not capture this order.";

      this.updateOrder.run(
        updatedAt,
        status,
        record.orderStatus,
        record.captureStatus,
        record.capturedAmount,
        record.capturedCurrency,
        message,
        orderID,
      );

      return;
    }

    const { outcome } = result;

    let status: PaymentStatus;

    if (outcome.paid) {
      status = "PAID";
    } else if (outcome.problem === "AMOUNT_MISMATCH") {
      status = "NEEDS_REVIEW";
    } else if (outcome.problem === "NOT_CAPTURED") {
      status = "UNKNOWN";
    } else if (outcome.captureStatus === "PENDING") {
      status = "PENDING";
    } else {
      status = "FAILED";
    }

    this.updateOrder.run(
      updatedAt,
      status,
      outcome.orderStatus,
      outcome.captureStatus,
      outcome.amount,
      outcome.currency,
      outcome.message,
      orderID,
    );
  }

  close(): void {
    this.db.close();
  }
}

export function toOrderView(record: OrderRecord) {
  const message =
    record.status === "CREATED"
      ? "Checkout has not been completed for this order."
      : record.message;

  return {
    orderID: record.orderID,
    paymentStatus: record.status,
    paid: record.status === "PAID",
    expectedAmount: record.expected.value,
    expectedCurrency: record.expected.currency,
    orderStatus: record.orderStatus,
    captureStatus: record.captureStatus,
    amount: record.capturedAmount,
    currency: record.capturedCurrency,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    ...(message ? { message } : {}),
  };
}
