// Registry of PayPal orders created by this backend, with their verified
// payment status.
//
// LOCAL DEMO ONLY: orders are kept in memory. Restarting the backend loses
// every record, so the frontend can no longer recover or capture orders created
// before the restart. Replace this with a persistent database before any
// deployment.
import type { CaptureResult, ExpectedAmount } from "./paypalCapture.js";

export type PaymentStatus =
  | "CREATED" // Order created; buyer approval or capture not finished.
  | "PAID" // Verified COMPLETED capture of the expected amount and currency.
  | "PENDING" // PayPal holds the capture as PENDING.
  | "FAILED" // PayPal rejected, declined, or failed the capture.
  | "NEEDS_REVIEW" // Captured amount or currency does not match; never paid.
  | "UNKNOWN"; // PayPal's answer was unclear; checking again is safe.

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

// PayPal order IDs are short alphanumeric strings.
export function isValidOrderID(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z0-9-]{1,100}$/i.test(value);
}

const UNKNOWN_MESSAGE =
  "Could not confirm the payment status with PayPal. Check again in a moment; this will not charge twice.";

// Statuses that are settled locally and never sent back to PayPal.
const FINAL_STATUSES = new Set<PaymentStatus>(["PAID", "NEEDS_REVIEW"]);

export class OrderRegistry {
  private readonly orders = new Map<string, OrderRecord>();
  private readonly capturesInFlight = new Map<string, Promise<OrderRecord>>();
  private readonly now: () => Date;
  private readonly maxOrders: number;

  constructor(options: { now?: () => Date; maxOrders?: number } = {}) {
    this.now = options.now ?? (() => new Date());
    this.maxOrders = options.maxOrders ?? 500;
  }

  register(orderID: string, expected: ExpectedAmount): OrderRecord {
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
    this.orders.set(orderID, record);

    // Bound memory use; Map iteration order is insertion order.
    while (this.orders.size > this.maxOrders) {
      const oldest = this.orders.keys().next().value;
      if (oldest === undefined) break;
      this.orders.delete(oldest);
    }
    return record;
  }

  get(orderID: string): OrderRecord | undefined {
    return this.orders.get(orderID);
  }

  // Capture a registered order and record the verified result. Settled orders
  // are returned without contacting PayPal, and concurrent requests for the
  // same order share a single PayPal call. If `runCapture` throws (for example
  // PayPal authentication failed before any capture was sent), the record is
  // left unchanged.
  async capture(
    orderID: string,
    runCapture: (expected: ExpectedAmount) => Promise<CaptureResult>,
  ): Promise<OrderRecord | undefined> {
    const record = this.orders.get(orderID);
    if (!record) return undefined;
    if (FINAL_STATUSES.has(record.status)) return record;

    const inFlight = this.capturesInFlight.get(orderID);
    if (inFlight) return inFlight;

    const pending = runCapture(record.expected)
      .then((result) => this.applyCaptureResult(record, result))
      .finally(() => this.capturesInFlight.delete(orderID));
    this.capturesInFlight.set(orderID, pending);
    return pending;
  }

  private applyCaptureResult(
    record: OrderRecord,
    result: CaptureResult,
  ): OrderRecord {
    record.updatedAt = this.now();

    if (!result.ok) {
      record.status = result.reason === "STATUS_UNKNOWN" ? "UNKNOWN" : "FAILED";
      record.message =
        result.reason === "STATUS_UNKNOWN"
          ? UNKNOWN_MESSAGE
          : "PayPal could not capture this order.";
      return record;
    }

    const { outcome } = result;
    record.orderStatus = outcome.orderStatus;
    record.captureStatus = outcome.captureStatus;
    record.capturedAmount = outcome.amount;
    record.capturedCurrency = outcome.currency;
    record.message = outcome.message;

    if (outcome.paid) {
      record.status = "PAID";
    } else if (outcome.problem === "AMOUNT_MISMATCH") {
      record.status = "NEEDS_REVIEW";
    } else if (outcome.problem === "NOT_CAPTURED") {
      record.status = "UNKNOWN";
    } else if (outcome.captureStatus === "PENDING") {
      record.status = "PENDING";
    } else {
      record.status = "FAILED";
    }
    return record;
  }
}

// Public view of an order for the frontend. Contains no credentials and no
// buyer data.
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
