// Order types and helpers shared by the routes and both registries. Kept free
// of database code, so the production server (PostgreSQL) never loads the
// SQLite driver that only the unit tests use.
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
  // SHA-256 of the checkout token given to the browser that created the
  // order (see checkoutToken.ts). Null only for orders created before tokens
  // existed; those can't be captured or looked up through the API.
  checkoutTokenHash: string | null;
};

export interface OrderRegistryPort {
  register(
    orderID: string,
    expected: ExpectedAmount,
    checkoutTokenHash?: string | null,
  ): Promise<OrderRecord>;

  get(orderID: string): Promise<OrderRecord | undefined>;

  capture(
    orderID: string,
    runCapture: (expected: ExpectedAmount) => Promise<CaptureResult>,
  ): Promise<OrderRecord | undefined>;
}

export function isValidOrderID(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z0-9-]{1,100}$/i.test(value);
}

export const UNKNOWN_MESSAGE =
  "Could not confirm the payment status with PayPal. Check again in a moment; this will not charge twice.";

export const NOT_APPROVED_MESSAGE =
  "The buyer has not approved this payment at PayPal yet, so no capture was attempted.";

export const VOIDED_MESSAGE =
  "PayPal voided this order, so it can't be paid. Start a new checkout.";

export const FINAL_STATUSES = new Set<PaymentStatus>(["PAID", "NEEDS_REVIEW"]);

export type CaptureUpdate = {
  status: PaymentStatus;
  orderStatus: string | null;
  captureStatus: string | null;
  amount: string | null;
  currency: string | null;
  message: string | null;
};

// The row update for a capture result, shared by both registries. When
// PayPal gave no outcome, the values PayPal reported earlier are kept, so a
// failed retry doesn't erase what is known about the order.
export function captureUpdate(result: CaptureResult, previous: OrderRecord): CaptureUpdate {
  const kept = {
    orderStatus: previous.orderStatus,
    captureStatus: previous.captureStatus,
    amount: previous.capturedAmount,
    currency: previous.capturedCurrency,
  };

  if (!result.ok) {
    switch (result.reason) {
      case "NOT_APPROVED":
        // Nothing was sent to PayPal's capture endpoint, so the order keeps
        // its status and can still be captured once the buyer approves it.
        return {
          ...kept,
          status: previous.status,
          orderStatus: result.orderStatus ?? previous.orderStatus,
          message: NOT_APPROVED_MESSAGE,
        };
      case "VOIDED":
        return { ...kept, status: "FAILED", orderStatus: "VOIDED", message: VOIDED_MESSAGE };
      case "STATUS_UNKNOWN":
        return { ...kept, status: "UNKNOWN", message: UNKNOWN_MESSAGE };
      case "REJECTED":
        return { ...kept, status: "FAILED", message: "PayPal could not capture this order." };
    }
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

  return {
    status,
    orderStatus: outcome.orderStatus,
    captureStatus: outcome.captureStatus,
    amount: outcome.amount,
    currency: outcome.currency,
    message: outcome.message,
  };
}

// The order as the API returns it. Never includes the checkout token hash.
export function toOrderView(record: OrderRecord) {
  const message =
    record.status === "CREATED" && record.message !== NOT_APPROVED_MESSAGE
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
