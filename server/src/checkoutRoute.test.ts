// Regression tests for POST /api/payments/create-order. PayPal is a fake
// fetch, so no credentials are used and no Sandbox orders are created.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { OrderRegistry, type OrderRecord, type OrderRegistryPort } from "./orderRegistry.js";
import { hashCheckoutToken, isWellFormedCheckoutToken } from "./checkoutToken.js";
import {
  PAYMENT_CURRENCY,
  TEST_PAYMENT_AMOUNT,
  createCheckoutRouter,
  isPayPalApprovalUrl,
  resolveReturnOrigin,
} from "./checkoutRoute.js";

const ALLOWED = ["https://app.example", "http://localhost:5173"];
const BASE_URL = "https://api-m.sandbox.paypal.test";
const APPROVE = "https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T";

type PayPalCall = { url: string; headers: Record<string, string>; body: any };

function orderCreated(id = "5O190127TN364715T", approveHref: string | null = APPROVE) {
  return new Response(
    JSON.stringify({
      id,
      status: "CREATED",
      links: [
        { rel: "self", href: `${BASE_URL}/v2/checkout/orders/${id}` },
        ...(approveHref === null ? [] : [{ rel: "approve", href: approveHref }]),
      ],
    }),
    { status: 201, headers: { "Content-Type": "application/json" } },
  );
}

async function startApi(
  t: TestContext,
  paypal: () => Promise<Response>,
  registry: OrderRegistryPort = new OrderRegistry(),
) {
  const calls: PayPalCall[] = [];
  const logs: unknown[][] = [];
  const app = express();
  app.use(express.json());
  app.use(
    createCheckoutRouter({
      registry,
      allowedOrigins: ALLOWED,
      getAccessToken: async () => "test-access-token",
      fetch: async (url, init) => {
        calls.push({
          url,
          headers: init.headers as Record<string, string>,
          body: JSON.parse(String(init.body)),
        });
        return paypal();
      },
      baseUrl: BASE_URL,
      logger: { log: (...args) => logs.push(args), error: (...args) => logs.push(args) },
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const createOrder = async (body: unknown = {}, headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}/api/payments/create-order`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { createOrder, calls, logs, registry };
}

test("the amount and currency are fixed by the server, whatever the browser sends", async (t) => {
  const api = await startApi(t, async () => orderCreated());
  const tampered = {
    amount: "0.01",
    value: "0.01",
    currency: "JPY",
    currency_code: "JPY",
    purchase_units: [{ amount: { currency_code: "JPY", value: "0.01" } }],
    intent: "AUTHORIZE",
    return_url: "https://evil.example/steal",
  };

  const { status, body } = await api.createOrder(tampered);
  assert.equal(status, 200);
  const { checkoutToken, ...rest } = body;
  assert.deepEqual(rest, {
    orderID: "5O190127TN364715T",
    amount: "5.00",
    currency: "USD",
    approveUrl: APPROVE,
  });
  assert.ok(isWellFormedCheckoutToken(checkoutToken), "a 256-bit checkout token is returned");

  const sent = api.calls[0]!;
  assert.equal(sent.url, `${BASE_URL}/v2/checkout/orders`);
  assert.equal(sent.body.intent, "CAPTURE");
  assert.deepEqual(sent.body.purchase_units, [
    {
      amount: { currency_code: "USD", value: "5.00" },
      description: "PayPilot AI Sandbox test payment",
    },
  ]);
  assert.equal(sent.body.application_context.return_url, "https://app.example/?payment=return");

  const record = await api.registry.get("5O190127TN364715T");
  assert.deepEqual(record?.expected, { value: "5.00", currency: "USD" });
  assert.equal(record?.status, "CREATED");
  // Only the token's hash is stored, and the token never appears in logs.
  assert.equal(record?.checkoutTokenHash, hashCheckoutToken(checkoutToken as string));
  assert.ok(!JSON.stringify(api.logs).includes(checkoutToken as string));
  assert.equal(TEST_PAYMENT_AMOUNT, "5.00");
  assert.equal(PAYMENT_CURRENCY, "USD");
});

test("PayPal returns the buyer only to an allowed origin; a forged Origin gets the default", async (t) => {
  const api = await startApi(t, async () => orderCreated());

  await api.createOrder({}, { Origin: "http://localhost:5173" });
  assert.equal(api.calls[0]!.body.application_context.return_url, "http://localhost:5173/?payment=return");
  assert.equal(api.calls[0]!.body.application_context.cancel_url, "http://localhost:5173/?payment=cancel");

  await api.createOrder({}, { Origin: "https://evil.example" });
  assert.equal(api.calls[1]!.body.application_context.return_url, "https://app.example/?payment=return");

  await api.createOrder({});
  assert.equal(api.calls[2]!.body.application_context.return_url, "https://app.example/?payment=return");
});

test("each checkout is a new PayPal order with its own PayPal-Request-Id", async (t) => {
  const api = await startApi(t, async () => orderCreated(`ORDER${api.calls.length}`));
  await api.createOrder();
  await api.createOrder();
  const [first, second] = api.calls.map((call) => call.headers["PayPal-Request-Id"]);
  assert.match(first ?? "", /^[0-9a-f-]{36}$/);
  assert.notEqual(first, second);
  assert.equal(api.calls[0]!.headers.Authorization, "Bearer test-access-token");
});

test("the order is registered before the approval URL is returned", async (t) => {
  const order: string[] = [];
  const registry = new OrderRegistry();
  const tracking: OrderRegistryPort = {
    register: async (id, expected) => {
      order.push("registered");
      return registry.register(id, expected);
    },
    get: (id) => registry.get(id),
    capture: (id, run) => registry.capture(id, run),
  };
  const api = await startApi(t, async () => orderCreated(), tracking);
  const { status } = await api.createOrder();
  order.push("responded");
  assert.equal(status, 200);
  assert.deepEqual(order, ["registered", "responded"]);
});

test("if the order can't be registered, no approval URL is returned", async (t) => {
  const failing: OrderRegistryPort = {
    register: async (): Promise<OrderRecord> => {
      throw new Error("database is down at postgresql://user:secret@db");
    },
    get: async () => undefined,
    capture: async () => undefined,
  };
  const api = await startApi(t, async () => orderCreated(), failing);
  const { status, body } = await api.createOrder();
  assert.equal(status, 502);
  assert.deepEqual(body, { error: "Could not create PayPal order." });
});

test("an approval URL that isn't an HTTPS PayPal address is never sent to the browser", async (t) => {
  for (const href of [
    "javascript:alert(document.cookie)",
    "https://evil.example/checkoutnow?token=X",
    "https://www.sandbox.paypal.com.evil.example/checkoutnow",
    "http://www.sandbox.paypal.com/checkoutnow?token=X",
    "data:text/html,<script>alert(1)</script>",
    null,
  ]) {
    const api = await startApi(t, async () => orderCreated("BADLINKORDER", href));
    const { status, body } = await api.createOrder();
    assert.equal(status, 502, String(href));
    assert.deepEqual(body, { error: "PayPal did not provide an approval URL." });
    assert.equal(await api.registry.get("BADLINKORDER"), undefined, "the order is not registered");
  }
});

test("PayPal errors and timeouts give a generic 502 without PayPal's details", async (t) => {
  const failures: Array<() => Promise<Response>> = [
    async () =>
      new Response(
        JSON.stringify({
          name: "UNPROCESSABLE_ENTITY",
          message: "internal detail",
          debug_id: "abc123",
          details: [{ issue: "CURRENCY_NOT_SUPPORTED" }],
        }),
        { status: 422 },
      ),
    async () => new Response("<html>Bad gateway</html>", { status: 502 }),
    async () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    },
  ];
  for (const paypal of failures) {
    const api = await startApi(t, paypal);
    const { status, body } = await api.createOrder();
    assert.equal(status, 502);
    assert.deepEqual(body, { error: "Could not create PayPal order." });
  }
});

test("approval URL check accepts PayPal's live and Sandbox checkout hosts only", () => {
  assert.ok(isPayPalApprovalUrl("https://www.sandbox.paypal.com/checkoutnow?token=ABC"));
  assert.ok(isPayPalApprovalUrl("https://www.paypal.com/checkoutnow?token=ABC"));
  assert.ok(!isPayPalApprovalUrl("https://paypal.com.evil.example/"));
  assert.ok(!isPayPalApprovalUrl("https://evilpaypal.com/"));
  assert.ok(!isPayPalApprovalUrl("https://user:pass@www.paypal.com/"));
  assert.ok(!isPayPalApprovalUrl("https://www.paypal.com:8443/"));
  assert.ok(!isPayPalApprovalUrl("not a url"));
  assert.ok(!isPayPalApprovalUrl(42));
});

test("return origin resolution only ever picks an allowed origin", () => {
  assert.equal(resolveReturnOrigin("https://app.example", ALLOWED), "https://app.example");
  assert.equal(resolveReturnOrigin("https://evil.example", ALLOWED), "https://app.example");
  assert.equal(resolveReturnOrigin(undefined, ALLOWED), "https://app.example");
  assert.equal(resolveReturnOrigin("https://app.example/", ALLOWED), "https://app.example");
  assert.equal(resolveReturnOrigin(undefined, []), "http://localhost:5173");
});
