// PayPal capture logic, kept separate from the Express routes so it can be
// tested with a fake fetch and no credentials or real payments.
import { createHash } from "node:crypto";

// Pick only non-sensitive fields from a PayPal API error body for logging.
// Never log request headers, tokens, credentials, or detail `value` fields.
export type PayPalErrorBody = {
  name?: string;
  message?: string;
  debug_id?: string;
  details?: Array<{ issue?: string; description?: string; field?: string }>;
};

export function summarizePayPalError(response: Response, data: PayPalErrorBody) {
  return {
    httpStatus: response.status,
    name: data.name,
    message: data.message,
    debugId: data.debug_id ?? response.headers.get("paypal-debug-id"),
    issues: data.details?.map(({ issue, description, field }) => ({
      issue,
      description,
      field,
    })),
  };
}

export type PayPalOrderBody = PayPalErrorBody & {
  id?: string;
  status?: string;
  payer?: { address?: { country_code?: string } };
  purchase_units?: Array<{
    payments?: {
      captures?: Array<{
        id?: string;
        status?: string;
        amount?: { currency_code?: string; value?: string };
      }>;
    };
  }>;
};

export type ExpectedAmount = { value: string; currency: string };

export type CaptureOutcome = {
  orderID: string;
  orderStatus: string | null;
  captureID: string | null;
  captureStatus: string | null;
  amount: string | null;
  currency: string | null;
  paid: boolean;
  problem: "NOT_CAPTURED" | "CAPTURE_NOT_COMPLETED" | "AMOUNT_MISMATCH" | null;
  message: string | null;
};

export type CaptureResult =
  | { ok: true; outcome: CaptureOutcome; source: "capture" | "lookup" }
  | { ok: false; reason: "REJECTED" | "STATUS_UNKNOWN" }
  // The order isn't approved by the buyer yet (CREATED, SAVED, or
  // PAYER_ACTION_REQUIRED), or was voided. No capture request was sent.
  | { ok: false; reason: "NOT_APPROVED"; orderStatus: string | null }
  | { ok: false; reason: "VOIDED"; orderStatus: string | null };

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
type Logger = {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export type CaptureDeps = {
  fetch: FetchLike;
  baseUrl: string;
  accessToken: string;
  // The capture request's timeout (default 15 s).
  timeoutMs?: number;
  // Each order lookup's timeout (default 10 s). With the access token
  // request (15 s), one capture makes at most four PayPal requests taking
  // at most about 50 s, inside the 60 s lock-hold limit.
  lookupTimeoutMs?: number;
  logger?: Logger;
};

// PayPal Orders v2 order statuses (order_status in the published schema):
// CREATED, SAVED, APPROVED, VOIDED, COMPLETED, PAYER_ACTION_REQUIRED.
// Only an APPROVED order is sent to the capture endpoint.
const CAPTURABLE_STATUS = "APPROVED";

// The same order always gets the same PayPal-Request-Id, so a retried capture
// returns the earlier result instead of attempting a second capture. PayPal
// recommends IDs of at most 38 characters, so the order ID is hashed into a
// UUID-shaped value.
export function captureRequestId(orderID: string): string {
  const hex = createHash("sha256")
    .update(`paypilot-capture:${orderID}`)
    .digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function toCents(value: string | undefined): number | null {
  if (!value || !/^\d+(\.\d{1,2})?$/.test(value)) return null;
  return Math.round(Number(value) * 100);
}

// Decide whether an order (from a capture response or an order lookup) is paid.
// Only a COMPLETED capture of exactly the expected amount and currency counts.
export function evaluateCapture(
  orderID: string,
  order: PayPalOrderBody,
  expected: ExpectedAmount,
): CaptureOutcome {
  const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
  const base = {
    orderID,
    orderStatus: order.status ?? null,
    captureID: capture?.id ?? null,
    captureStatus: capture?.status ?? null,
    amount: capture?.amount?.value ?? null,
    currency: capture?.amount?.currency_code ?? null,
  };

  if (!capture) {
    return {
      ...base,
      paid: false,
      problem: "NOT_CAPTURED",
      message:
        "PayPal has not confirmed a captured payment for this order yet. Try again in a moment; retrying will not charge twice.",
    };
  }

  if (capture.status !== "COMPLETED") {
    return {
      ...base,
      paid: false,
      problem: "CAPTURE_NOT_COMPLETED",
      message:
        capture.status === "PENDING"
          ? "PayPal is still processing this payment (PENDING). It has not been confirmed."
          : `PayPal did not complete this payment (status: ${capture.status ?? "unknown"}).`,
    };
  }

  const expectedCents = toCents(expected.value);
  if (
    base.currency !== expected.currency ||
    expectedCents === null ||
    toCents(base.amount ?? undefined) !== expectedCents
  ) {
    return {
      ...base,
      paid: false,
      problem: "AMOUNT_MISMATCH",
      message:
        "The captured amount or currency does not match this checkout. Payment was not confirmed; review it in the PayPal Sandbox dashboard.",
    };
  }

  return { ...base, paid: true, problem: null, message: null };
}

async function readJson(response: Response): Promise<PayPalOrderBody | null> {
  try {
    return (await response.json()) as PayPalOrderBody;
  } catch {
    return null;
  }
}

function hasCapture(data: PayPalOrderBody): boolean {
  return Boolean(data.purchase_units?.[0]?.payments?.captures?.length);
}

// Responses that don't tell us whether money moved: check the order instead
// of reporting failure.
const STATUS_CHECK_ISSUES = new Set([
  "ORDER_ALREADY_CAPTURED",
  "ORDER_COMPLETION_IN_PROGRESS",
]);

function needsStatusCheck(response: Response, data: PayPalOrderBody | null) {
  if (data === null || response.status >= 500 || response.status === 409) {
    return true;
  }
  return Boolean(
    data.details?.some(({ issue }) => issue && STATUS_CHECK_ISSUES.has(issue)),
  );
}

export async function capturePayPalOrder(
  orderID: string,
  expected: ExpectedAmount,
  deps: CaptureDeps,
): Promise<CaptureResult> {
  const logger = deps.logger ?? console;
  const timeoutMs = deps.timeoutMs ?? 15000;
  const lookupTimeoutMs = deps.lookupTimeoutMs ?? 10000;
  const orderUrl = `${deps.baseUrl}/v2/checkout/orders/${encodeURIComponent(orderID)}`;

  const finish = (
    data: PayPalOrderBody,
    response: Response,
    source: "capture" | "lookup",
  ): CaptureResult => {
    const outcome = evaluateCapture(orderID, data, expected);
    const logResult = outcome.paid ? logger.log : logger.error;
    logResult("PayPal capture result:", {
      source,
      orderID,
      orderStatus: outcome.orderStatus,
      captureStatus: outcome.captureStatus,
      capturedAmount: outcome.amount,
      capturedCurrency: outcome.currency,
      expectedAmount: expected.value,
      expectedCurrency: expected.currency,
      paid: outcome.paid,
      problem: outcome.problem,
      payerCountry: data.payer?.address?.country_code,
      debugId: response.headers.get("paypal-debug-id"),
    });
    return { ok: true, outcome, source };
  };

  // Reads the order from PayPal. Any failure means the status is unknown,
  // which is safe to retry; it is never treated as paid or failed.
  const lookUp = async (
    when: "before capture" | "after capture",
  ): Promise<{ data: PayPalOrderBody; response: Response } | CaptureResult> => {
    try {
      const response = await deps.fetch(orderUrl, {
        method: "GET",
        headers: { Authorization: `Bearer ${deps.accessToken}` },
        signal: AbortSignal.timeout(lookupTimeoutMs),
      });
      const data = await readJson(response);

      if (!response.ok || !data) {
        logger.error(`PayPal order lookup ${when} failed:`, {
          orderID,
          ...summarizePayPalError(response, data ?? {}),
        });
        return { ok: false, reason: "STATUS_UNKNOWN" };
      }
      return { data, response };
    } catch (error) {
      logger.error(`PayPal order lookup ${when} did not complete:`, {
        orderID,
        error: error instanceof Error ? error.name : "UnknownError",
      });
      return { ok: false, reason: "STATUS_UNKNOWN" };
    }
  };

  // 1. Check the order before capturing. A capture is sent only for an
  // order the buyer has approved, so a request made too early (or by
  // someone other than the buyer) never reaches PayPal's capture endpoint
  // and can't use up this order's stable PayPal-Request-Id with a failure.
  const before = await lookUp("before capture");
  if (!("data" in before)) return before;

  const orderStatus = before.data.status ?? null;

  // Already captured, for example by an earlier attempt whose result was
  // not recorded: evaluate it without capturing again.
  if (orderStatus === "COMPLETED" || hasCapture(before.data)) {
    return finish(before.data, before.response, "lookup");
  }

  if (orderStatus !== CAPTURABLE_STATUS) {
    const reason = orderStatus === "VOIDED" ? "VOIDED" : "NOT_APPROVED";
    logger.log("PayPal order is not approved; no capture was sent:", {
      orderID,
      orderStatus,
      debugId: before.response.headers.get("paypal-debug-id"),
    });
    return { ok: false, reason, orderStatus };
  }

  // 2. Capture the approved order.
  try {
    const response = await deps.fetch(`${orderUrl}/capture`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deps.accessToken}`,
        "Content-Type": "application/json",
        "PayPal-Request-Id": captureRequestId(orderID),
        Prefer: "return=representation",
      },
      body: "{}",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await readJson(response);

    if (response.ok && data && hasCapture(data)) {
      return finish(data, response, "capture");
    }

    if (!response.ok && !needsStatusCheck(response, data)) {
      logger.error("PayPal capture failed:", {
        orderID,
        ...summarizePayPalError(response, data ?? {}),
      });
      return { ok: false, reason: "REJECTED" };
    }

    logger.error("PayPal capture result unclear; checking order status:", {
      orderID,
      ...summarizePayPalError(response, data ?? {}),
    });
  } catch (error) {
    logger.error("PayPal capture request did not complete; checking order status:", {
      orderID,
      error: error instanceof Error ? error.name : "UnknownError",
    });
  }

  // 3. The capture's result is unclear: check the order again.
  const after = await lookUp("after capture");
  if (!("data" in after)) return after;
  return finish(after.data, after.response, "lookup");
}
