// Tests for PayPal capture handling. PayPal is replaced by a fake fetch, so
// these never use real credentials, make network requests, or move money.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  capturePayPalOrder,
  captureRequestId,
  type CaptureResult,
} from "./paypalCapture.js";

const ORDER_ID = "5O190127TN364715T";
const EXPECTED = { value: "5.00", currency: "USD" };
const FAKE_TOKEN = "fake-access-token-for-tests";

type FakeStep = { status: number; body: unknown } | { throws: unknown };

function orderBody(
  status: string,
  capture?: { status: string; value: string; currency: string },
) {
  return {
    id: ORDER_ID,
    status,
    purchase_units: [
      {
        payments: capture
          ? {
              captures: [
                {
                  id: "3C679366HH908993F",
                  status: capture.status,
                  amount: { value: capture.value, currency_code: capture.currency },
                },
              ],
            }
          : {},
      },
    ],
  };
}

function paypalError(status: number, issue: string) {
  return {
    status,
    body: {
      name: "UNPROCESSABLE_ENTITY",
      debug_id: "fake-debug-id",
      details: [{ issue, description: `${issue} (test)` }],
    },
  };
}

const completed = (value = "5.00", currency = "USD") =>
  orderBody("COMPLETED", { status: "COMPLETED", value, currency });

async function runCapture(steps: FakeStep[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const logLines: string[] = [];
  const record = (...args: unknown[]) => logLines.push(JSON.stringify(args));

  const result = await capturePayPalOrder(ORDER_ID, EXPECTED, {
    baseUrl: "https://paypal.test",
    accessToken: FAKE_TOKEN,
    logger: { log: record, error: record },
    fetch: async (url, init) => {
      calls.push({ url, init });
      const step = steps.shift();
      if (!step) throw new Error("Unexpected extra PayPal request");
      if ("throws" in step) throw step.throws;
      return new Response(JSON.stringify(step.body), {
        status: step.status,
        headers: { "paypal-debug-id": "fake-debug-id" },
      });
    },
  });

  assert.equal(steps.length, 0, "every expected PayPal call was made");
  assert.ok(
    logLines.every((line) => !line.includes(FAKE_TOKEN)),
    "logs never contain the access token",
  );
  return { result, calls };
}

function requestId(call: { init: RequestInit } | undefined) {
  return (call?.init.headers as Record<string, string>)["PayPal-Request-Id"];
}

function paidOutcome(result: CaptureResult) {
  assert.ok(result.ok, "capture result is known");
  return result.outcome;
}

test("a completed USD 5.00 capture is paid and reports PayPal's values", async () => {
  const { result, calls } = await runCapture([{ status: 201, body: completed() }]);
  const outcome = paidOutcome(result);

  assert.equal(outcome.paid, true);
  assert.equal(outcome.captureStatus, "COMPLETED");
  assert.equal(outcome.amount, "5.00");
  assert.equal(outcome.currency, "USD");
  assert.equal(result.ok && result.source, "capture");

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, `https://paypal.test/v2/checkout/orders/${ORDER_ID}/capture`);
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(requestId(calls[0]), captureRequestId(ORDER_ID));
  assert.equal(
    (calls[0]?.init.headers as Record<string, string>).Prefer,
    "return=representation",
  );
});

for (const [label, value, currency] of [
  ["a wrong amount", "4.00", "USD"],
  ["a wrong currency", "5.00", "EUR"],
  ["a malformed amount", "5.00abc", "USD"],
] as const) {
  test(`a completed capture with ${label} is not paid`, async () => {
    const { result } = await runCapture([
      { status: 201, body: completed(value, currency) },
    ]);
    const outcome = paidOutcome(result);

    assert.equal(outcome.paid, false);
    assert.equal(outcome.problem, "AMOUNT_MISMATCH");
  });
}

for (const status of ["PENDING", "DECLINED", "FAILED"]) {
  test(`a ${status} capture is not paid`, async () => {
    const { result } = await runCapture([
      {
        status: 201,
        body: orderBody("COMPLETED", { status, value: "5.00", currency: "USD" }),
      },
    ]);
    const outcome = paidOutcome(result);

    assert.equal(outcome.paid, false);
    assert.equal(outcome.problem, "CAPTURE_NOT_COMPLETED");
    assert.equal(outcome.captureStatus, status);
  });
}

test("a success response without capture details is checked and not paid", async () => {
  const { result, calls } = await runCapture([
    { status: 201, body: { id: ORDER_ID, status: "COMPLETED" } },
    { status: 200, body: orderBody("APPROVED") },
  ]);
  const outcome = paidOutcome(result);

  assert.equal(outcome.paid, false);
  assert.equal(outcome.problem, "NOT_CAPTURED");
  assert.equal(calls[1]?.init.method, "GET");
});

test("retries of the same order reuse one short, stable PayPal-Request-Id", async () => {
  const first = await runCapture([{ status: 201, body: completed() }]);
  // PayPal answers a repeated request ID with the earlier result.
  const retry = await runCapture([{ status: 200, body: completed() }]);

  assert.equal(requestId(first.calls[0]), requestId(retry.calls[0]));
  assert.equal(paidOutcome(retry.result).paid, true);
  assert.ok(captureRequestId(ORDER_ID).length <= 38);
  assert.notEqual(captureRequestId(ORDER_ID), captureRequestId("8XY12345AB678901C"));
});

test("an already-captured order is looked up instead of reported as failed", async () => {
  const { result, calls } = await runCapture([
    paypalError(422, "ORDER_ALREADY_CAPTURED"),
    { status: 200, body: completed() },
  ]);
  const outcome = paidOutcome(result);

  assert.equal(outcome.paid, true);
  assert.equal(result.ok && result.source, "lookup");
  assert.equal(calls[1]?.url, `https://paypal.test/v2/checkout/orders/${ORDER_ID}`);
  assert.equal(calls[1]?.init.method, "GET");
});

test("an already-captured order with the wrong amount is still not paid", async () => {
  const { result } = await runCapture([
    paypalError(422, "ORDER_ALREADY_CAPTURED"),
    { status: 200, body: completed("50.00") },
  ]);

  assert.equal(paidOutcome(result).problem, "AMOUNT_MISMATCH");
});

test("a capture timeout checks the order and reports a completed capture", async () => {
  const { result } = await runCapture([
    { throws: new DOMException("The operation timed out.", "TimeoutError") },
    { status: 200, body: completed() },
  ]);

  assert.equal(paidOutcome(result).paid, true);
});

test("a capture timeout on an order not yet captured is not paid", async () => {
  const { result } = await runCapture([
    { throws: new DOMException("The operation timed out.", "TimeoutError") },
    { status: 200, body: orderBody("APPROVED") },
  ]);
  const outcome = paidOutcome(result);

  assert.equal(outcome.paid, false);
  assert.equal(outcome.problem, "NOT_CAPTURED");
});

test("a PayPal 5xx response checks the order status", async () => {
  const { result } = await runCapture([
    { status: 503, body: { name: "SERVICE_UNAVAILABLE" } },
    { status: 200, body: completed() },
  ]);

  assert.equal(paidOutcome(result).paid, true);
});

test("when both capture and lookup fail, the status is unknown, not failed or paid", async () => {
  const { result } = await runCapture([
    { throws: new DOMException("The operation timed out.", "TimeoutError") },
    { throws: new TypeError("fetch failed") },
  ]);

  assert.deepEqual(result, { ok: false, reason: "STATUS_UNKNOWN" });
});

test("a definite rejection such as ORDER_NOT_APPROVED fails without a lookup", async () => {
  const { result, calls } = await runCapture([
    paypalError(422, "ORDER_NOT_APPROVED"),
  ]);

  assert.deepEqual(result, { ok: false, reason: "REJECTED" });
  assert.equal(calls.length, 1);
});
