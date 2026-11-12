// Regression tests for a database outage, without a database: the registry
// points at a port where nothing listens. Requests must fail fast with a
// short JSON error that reveals neither the connection string nor internal
// details, and PayPal must never be called for an order that can't be
// checked.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { PostgresOrderRegistry, createPostgresPool } from "./postgresOrderRegistry.js";
import { createPaymentRouter } from "./paymentRoutes.js";
import { createCheckoutRouter } from "./checkoutRoute.js";
import { createCheckoutToken } from "./checkoutToken.js";

// Nothing listens on port 1. The password is a marker that must never leak.
const UNREACHABLE = "postgresql://paypilot:LeakMarkerPassword123@127.0.0.1:1/paypilot";

async function startApi(t: TestContext) {
  const registry = new PostgresOrderRegistry(
    createPostgresPool(UNREACHABLE, { connectionTimeoutMillis: 3000 }),
  );
  t.after(() => registry.close());
  let paypalCalls = 0;
  const logs: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => logs.push(args.map(String).join(" ")));

  const app = express();
  app.use(express.json());
  app.use(
    createCheckoutRouter({
      registry,
      allowedOrigins: ["https://app.example"],
      getAccessToken: async () => "fake-access-token",
      fetch: async () => {
        paypalCalls++;
        return new Response(
          JSON.stringify({
            id: "5O190127TN364715T",
            status: "CREATED",
            links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T" }],
          }),
          { status: 201 },
        );
      },
      baseUrl: "https://paypal.test",
      logger: { log() {}, error: (...args: unknown[]) => logs.push(args.map(String).join(" ")) },
    }),
  );
  app.use(
    createPaymentRouter(registry, async () => {
      paypalCalls++;
      throw new Error("PayPal must not be called");
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/payments`;
  return { base, logs, paypalCalls: () => paypalCalls };
}

const token = createCheckoutToken().token;

test("with the database down, payment requests fail fast with a generic JSON error", { timeout: 30_000 }, async (t) => {
  const api = await startApi(t);
  const startedAt = Date.now();

  const status = await fetch(`${api.base}/orders/5O190127TN364715T`, { headers: { "X-Checkout-Token": token } });
  const capture = await fetch(`${api.base}/capture-order`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderID: "5O190127TN364715T", checkoutToken: token }),
  });
  const create = await fetch(`${api.base}/create-order`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });

  assert.ok(Date.now() - startedAt < 15_000, "no request hangs");
  assert.equal(status.status, 500);
  assert.deepEqual(await status.json(), { error: "Could not retrieve payment status." });
  assert.equal(capture.status, 502);
  assert.deepEqual(await capture.json(), { error: "Could not capture PayPal payment." });
  assert.equal(create.status, 502);
  assert.deepEqual(await create.json(), { error: "Could not create PayPal order." }, "no approval URL without a registered order");

  // Only the order creation itself reached PayPal; no capture was attempted.
  assert.equal(api.paypalCalls(), 1);
  const logged = api.logs.join("\n");
  assert.ok(!logged.includes("LeakMarkerPassword123"), "the connection string's password is never logged");
});
