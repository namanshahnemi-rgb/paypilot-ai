// Regression tests for checkout ownership and capture before approval.
//
// Ownership: an order can only be captured or looked up with the checkout
// token issued to the browser that created it. Knowing the order ID (which
// appears in PayPal URLs) is not enough.
//
// Approval: a capture is sent to PayPal only for an APPROVED order, so an
// early or repeated capture request can't fail the order or use up its
// stable PayPal-Request-Id.
//
// PayPal is a scripted fake fetch; no credentials or real orders are used.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { OrderRegistry } from "./orderRegistry.js";
import { createPaymentRouter } from "./paymentRoutes.js";
import { captureRequestId, capturePayPalOrder, type ExpectedAmount } from "./paypalCapture.js";
import {
  checkoutTokenMatches,
  createCheckoutToken,
  hashCheckoutToken,
  isWellFormedCheckoutToken,
} from "./checkoutToken.js";

const ORDER_ID = "5O190127TN364715T";
const EXPECTED: ExpectedAmount = { value: "5.00", currency: "USD" };
const silentLogger = { log() {}, error() {} };

function paypalOrder(status: string, captured = false) {
  return {
    id: ORDER_ID,
    status,
    purchase_units: [
      {
        payments: captured
          ? {
              captures: [
                { id: "CAPTURE1", status: "COMPLETED", amount: { value: "5.00", currency_code: "USD" } },
              ],
            }
          : {},
      },
    ],
  };
}

// A fake PayPal whose order status can change, like a real one: CREATED until
// the buyer approves, COMPLETED once captured. Records every request.
function fakePayPal(initialStatus = "CREATED") {
  let status = initialStatus;
  const requests: Array<{ method: string; path: string; requestId: string | null }> = [];
  const fetch = async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const method = init.method ?? "GET";
    requests.push({ method, path, requestId: new Headers(init.headers).get("PayPal-Request-Id") });
    if (method === "GET") {
      return new Response(JSON.stringify(paypalOrder(status, status === "COMPLETED")), { status: 200 });
    }
    // Capture endpoint: PayPal's documented 422 for an unapproved order.
    if (status !== "APPROVED") {
      return new Response(
        JSON.stringify({ name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_NOT_APPROVED" }] }),
        { status: 422 },
      );
    }
    status = "COMPLETED";
    return new Response(JSON.stringify(paypalOrder("COMPLETED", true)), { status: 201 });
  };
  return {
    runCapture: (orderID: string, expected: ExpectedAmount) =>
      capturePayPalOrder(orderID, expected, {
        baseUrl: "https://paypal.test",
        accessToken: "fake-access-token-for-tests",
        logger: silentLogger,
        fetch,
      }),
    setStatus: (next: string) => {
      status = next;
    },
    captureRequests: () => requests.filter((r) => r.method === "POST"),
    requests: () => requests,
  };
}

async function startApi(t: TestContext, paypal = fakePayPal()) {
  const registry = new OrderRegistry();
  const owner = createCheckoutToken();
  await registry.register(ORDER_ID, EXPECTED, owner.hash);

  const app = express();
  app.use(express.json());
  app.use(createPaymentRouter(registry, paypal.runCapture));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/payments`;

  const read = async (response: Response) => ({
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  });
  return {
    registry,
    owner,
    paypal,
    capture: async (body: Record<string, unknown>) =>
      read(
        await fetch(`${base}/capture-order`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      ),
    status: async (orderID: string, headers: Record<string, string> = {}) =>
      read(await fetch(`${base}/orders/${encodeURIComponent(orderID)}`, { headers })),
  };
}

// --- Ownership --------------------------------------------------------------

test("another browser session's checkout token can't capture the order", async (t) => {
  const api = await startApi(t, fakePayPal("APPROVED"));
  const attacker = createCheckoutToken();

  const result = await api.capture({ orderID: ORDER_ID, checkoutToken: attacker.token });

  assert.equal(result.status, 404);
  assert.match(String(result.body.error), /not known to the server/);
  assert.deepEqual(api.paypal.requests(), [], "PayPal is never called");
  assert.equal((await api.registry.get(ORDER_ID))?.status, "CREATED", "the order is unchanged");

  // The real owner can still capture it afterwards.
  const owner = await api.capture({ orderID: ORDER_ID, checkoutToken: api.owner.token });
  assert.equal(owner.status, 200);
  assert.equal(owner.body.paymentStatus, "PAID");
});

test("another session can't read the order's status", async (t) => {
  const api = await startApi(t);
  const attacker = createCheckoutToken();

  const lookup = await api.status(ORDER_ID, { "X-Checkout-Token": attacker.token });
  assert.equal(lookup.status, 404);
  assert.equal("paymentStatus" in lookup.body, false, "no payment information is returned");

  const ownerLookup = await api.status(ORDER_ID, { "X-Checkout-Token": api.owner.token });
  assert.equal(ownerLookup.status, 200);
  assert.equal(ownerLookup.body.paymentStatus, "CREATED");
});

test("a request without a checkout token, or with a malformed one, is rejected before any lookup", async (t) => {
  const api = await startApi(t, fakePayPal("APPROVED"));
  for (const checkoutToken of [undefined, "", "short", "x".repeat(43) + "!", 12345, { $ne: null }, api.owner.hash]) {
    const result = await api.capture({ orderID: ORDER_ID, checkoutToken });
    assert.equal(result.status, 400, JSON.stringify(checkoutToken));
  }
  assert.equal((await api.status(ORDER_ID)).status, 400);
  assert.equal((await api.status(ORDER_ID, { "X-Checkout-Token": "not-a-token" })).status, 400);
  assert.deepEqual(api.paypal.requests(), []);
});

test("a wrong token and an unknown order get the same answer, so order IDs can't be probed", async (t) => {
  const api = await startApi(t);
  const someone = createCheckoutToken().token;
  const wrongToken = await api.status(ORDER_ID, { "X-Checkout-Token": someone });
  const unknownOrder = await api.status("8XY12345AB678901C", { "X-Checkout-Token": someone });
  assert.equal(wrongToken.status, unknownOrder.status);
  assert.deepEqual(wrongToken.body, unknownOrder.body);
});

test("an order registered without a token (before tokens existed) can't be captured or read", async (t) => {
  const api = await startApi(t, fakePayPal("APPROVED"));
  await api.registry.register("LEGACYORDER1", EXPECTED);
  const token = createCheckoutToken().token;

  assert.equal((await api.capture({ orderID: "LEGACYORDER1", checkoutToken: token })).status, 404);
  assert.equal((await api.status("LEGACYORDER1", { "X-Checkout-Token": token })).status, 404);
  assert.deepEqual(api.paypal.requests(), []);
});

test("responses never contain the checkout token or its hash", async (t) => {
  const api = await startApi(t, fakePayPal("APPROVED"));
  const captured = await api.capture({ orderID: ORDER_ID, checkoutToken: api.owner.token });
  const looked = await api.status(ORDER_ID, { "X-Checkout-Token": api.owner.token });
  for (const body of [captured.body, looked.body]) {
    const text = JSON.stringify(body);
    assert.ok(!text.includes(api.owner.token));
    assert.ok(!text.includes(api.owner.hash));
    assert.equal("checkoutTokenHash" in body, false);
  }
});

test("checkout tokens are 256-bit random values, matched by hash only", () => {
  const tokens = new Set(Array.from({ length: 200 }, () => createCheckoutToken().token));
  assert.equal(tokens.size, 200, "no repeats");
  const { token, hash } = createCheckoutToken();
  assert.ok(isWellFormedCheckoutToken(token));
  assert.equal(Buffer.from(token, "base64url").length, 32);
  assert.equal(hash, hashCheckoutToken(token));
  assert.ok(checkoutTokenMatches(hash, token));
  assert.ok(!checkoutTokenMatches(hash, createCheckoutToken().token));
  assert.ok(!checkoutTokenMatches(null, token), "orders without a hash never match");
  assert.ok(!checkoutTokenMatches("not-a-hash", token));
  assert.ok(!checkoutTokenMatches(hash, hash), "the hash itself is not a token");
});

// --- Capture before approval -------------------------------------------------

test("a capture before the buyer approves sends nothing to PayPal's capture endpoint and leaves the order capturable", async (t) => {
  const api = await startApi(t, fakePayPal("CREATED"));
  const request = { orderID: ORDER_ID, checkoutToken: api.owner.token };

  // Several early or repeated requests, for example a double click or a
  // returning tab that refreshes before PayPal finishes.
  for (let i = 0; i < 3; i++) {
    const early = await api.capture(request);
    assert.equal(early.status, 200);
    assert.equal(early.body.paymentStatus, "CREATED", "not FAILED, so it doesn't block the checkout");
    assert.equal(early.body.paid, false);
    assert.equal(early.body.orderStatus, "CREATED");
    assert.match(String(early.body.message), /not approved this payment/);
  }
  assert.deepEqual(api.paypal.captureRequests(), [], "no capture request was sent");

  // The buyer approves; the next capture is PayPal's first capture request
  // for this order, with its stable PayPal-Request-Id.
  api.paypal.setStatus("APPROVED");
  const approved = await api.capture(request);
  assert.equal(approved.body.paymentStatus, "PAID");
  assert.deepEqual(
    api.paypal.captureRequests().map((r) => r.requestId),
    [captureRequestId(ORDER_ID)],
  );

  // Repeats after payment never reach PayPal again.
  const before = api.paypal.requests().length;
  assert.equal((await api.capture(request)).body.paymentStatus, "PAID");
  assert.equal(api.paypal.requests().length, before);
});

for (const status of ["CREATED", "SAVED", "PAYER_ACTION_REQUIRED"]) {
  test(`an order in ${status} is not captured`, async () => {
    const paypal = fakePayPal(status);
    const result = await paypal.runCapture(ORDER_ID, EXPECTED);
    assert.deepEqual(result, { ok: false, reason: "NOT_APPROVED", orderStatus: status });
    assert.deepEqual(paypal.captureRequests(), []);
  });
}

test("a cancelled checkout (the buyer left PayPal without approving) is never captured", async (t) => {
  // PayPal leaves a cancelled checkout's order unapproved (CREATED).
  const api = await startApi(t, fakePayPal("CREATED"));
  const result = await api.capture({ orderID: ORDER_ID, checkoutToken: api.owner.token });
  assert.equal(result.body.paid, false);
  assert.deepEqual(api.paypal.captureRequests(), []);
});

test("a voided order is recorded as FAILED without a capture request", async (t) => {
  const api = await startApi(t, fakePayPal("VOIDED"));
  const result = await api.capture({ orderID: ORDER_ID, checkoutToken: api.owner.token });
  assert.equal(result.body.paymentStatus, "FAILED");
  assert.equal(result.body.orderStatus, "VOIDED");
  assert.match(String(result.body.message), /voided/);
  assert.deepEqual(api.paypal.captureRequests(), []);
});

test("an order PayPal already captured is confirmed from the lookup, without capturing again", async (t) => {
  const api = await startApi(t, fakePayPal("COMPLETED"));
  const result = await api.capture({ orderID: ORDER_ID, checkoutToken: api.owner.token });
  assert.equal(result.body.paymentStatus, "PAID");
  assert.equal(result.body.captureStatus, "COMPLETED");
  assert.deepEqual(api.paypal.captureRequests(), []);
});

test("if the status check fails, nothing is captured and the result is UNKNOWN (safe to retry)", async () => {
  for (const failure of [
    async () => new Response("{}", { status: 503 }),
    async () => new Response("not json", { status: 200 }),
    async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    },
  ]) {
    const methods: string[] = [];
    const result = await capturePayPalOrder(ORDER_ID, EXPECTED, {
      baseUrl: "https://paypal.test",
      accessToken: "fake",
      logger: silentLogger,
      fetch: async (_url, init) => {
        methods.push(init.method ?? "GET");
        return failure();
      },
    });
    assert.deepEqual(result, { ok: false, reason: "STATUS_UNKNOWN" });
    assert.deepEqual(methods, ["GET"], "no capture request after a failed check");
  }
});

test("simultaneous capture requests for an approved order make one capture request", async (t) => {
  const api = await startApi(t, fakePayPal("APPROVED"));
  const request = { orderID: ORDER_ID, checkoutToken: api.owner.token };
  const results = await Promise.all([api.capture(request), api.capture(request), api.capture(request)]);
  assert.deepEqual(results.map((r) => r.body.paymentStatus), ["PAID", "PAID", "PAID"]);
  assert.equal(api.paypal.captureRequests().length, 1);
});
