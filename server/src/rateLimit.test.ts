// Regression tests for the public endpoint limits: an unauthenticated client
// must not be able to spend the Gemini quota, create unlimited PayPal orders,
// or flood the payment endpoints.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import {
  createRateLimiter,
  readLimit,
  readTrustProxy,
  type RateLimitRule,
} from "./rateLimit.js";

const silent = { error() {} };

async function startApi(
  t: TestContext,
  rules: RateLimitRule[],
  options: { trustProxy?: number | false; maxTrackedClients?: number } = {},
) {
  let time = 1_000_000;
  let handled = 0;
  const app = express();
  app.set("trust proxy", options.trustProxy ?? false);
  const limiter = createRateLimiter({
    rules,
    now: () => time,
    ...(options.maxTrackedClients ? { maxTrackedClients: options.maxTrackedClients } : {}),
  });
  app.post("/limited", limiter, (_req, res) => {
    handled++;
    res.json({ ok: true });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    send: async (headers: Record<string, string> = {}) => {
      const response = await fetch(`${base}/limited`, { method: "POST", headers });
      return {
        status: response.status,
        retryAfter: response.headers.get("retry-after"),
        body: (await response.json()) as { ok?: boolean; error?: string },
      };
    },
    advance: (ms: number) => {
      time += ms;
    },
    handled: () => handled,
  };
}

const perClient = (max: number, windowMs = 60_000): RateLimitRule => ({
  scope: "client",
  windowMs,
  max,
  message: "Too many requests from you.",
});

const global = (max: number, windowMs = 60_000): RateLimitRule => ({
  scope: "global",
  windowMs,
  max,
  message: "Daily budget used.",
});

test("requests over the limit get a 429 JSON error with Retry-After, and never reach the handler", async (t) => {
  const api = await startApi(t, [perClient(3)]);
  for (let i = 0; i < 3; i++) assert.equal((await api.send()).status, 200);

  const refused = await api.send();
  assert.equal(refused.status, 429);
  assert.equal(refused.body.error, "Too many requests from you.");
  assert.equal(refused.retryAfter, "60");
  assert.equal(api.handled(), 3);
});

test("the limit resets when its window ends", async (t) => {
  const api = await startApi(t, [perClient(1, 10_000)]);
  assert.equal((await api.send()).status, 200);
  assert.equal((await api.send()).status, 429);

  api.advance(9_000);
  const stillRefused = await api.send();
  assert.equal(stillRefused.status, 429);
  assert.equal(stillRefused.retryAfter, "1");

  api.advance(1_000);
  assert.equal((await api.send()).status, 200);
});

test("a forged X-Forwarded-For header does not give a fresh limit when no proxy is trusted", async (t) => {
  const api = await startApi(t, [perClient(2)]);
  assert.equal((await api.send({ "X-Forwarded-For": "203.0.113.1" })).status, 200);
  assert.equal((await api.send({ "X-Forwarded-For": "203.0.113.2" })).status, 200);
  assert.equal((await api.send({ "X-Forwarded-For": "203.0.113.3" })).status, 429);
});

test("with a trusted proxy, clients are limited separately by their forwarded address", async (t) => {
  const api = await startApi(t, [perClient(1)], { trustProxy: 1 });
  assert.equal((await api.send({ "X-Forwarded-For": "203.0.113.1" })).status, 200);
  assert.equal((await api.send({ "X-Forwarded-For": "203.0.113.1" })).status, 429);
  assert.equal((await api.send({ "X-Forwarded-For": "203.0.113.2" })).status, 200);
});

test("a global budget caps every client together", async (t) => {
  const api = await startApi(t, [perClient(10), global(3)], { trustProxy: 1 });
  for (const ip of ["203.0.113.1", "203.0.113.2", "203.0.113.3"]) {
    assert.equal((await api.send({ "X-Forwarded-For": ip })).status, 200);
  }
  const refused = await api.send({ "X-Forwarded-For": "203.0.113.4" });
  assert.equal(refused.status, 429);
  assert.equal(refused.body.error, "Daily budget used.");
});

test("requests refused by a client's own limit don't use up the global budget", async (t) => {
  const api = await startApi(t, [perClient(1), global(2)], { trustProxy: 1 });
  assert.equal((await api.send({ "X-Forwarded-For": "203.0.113.1" })).status, 200);
  for (let i = 0; i < 5; i++) {
    assert.equal((await api.send({ "X-Forwarded-For": "203.0.113.1" })).status, 429);
  }
  assert.equal((await api.send({ "X-Forwarded-For": "203.0.113.2" })).status, 200);
});

test("past the tracked-client cap, new addresses share one counter instead of using more memory", async (t) => {
  const api = await startApi(t, [perClient(1)], { trustProxy: 1, maxTrackedClients: 2 });
  assert.equal((await api.send({ "X-Forwarded-For": "203.0.113.1" })).status, 200);
  assert.equal((await api.send({ "X-Forwarded-For": "203.0.113.2" })).status, 200);
  // Both new addresses fall into the shared overflow counter.
  assert.equal((await api.send({ "X-Forwarded-For": "203.0.113.3" })).status, 200);
  assert.equal((await api.send({ "X-Forwarded-For": "203.0.113.4" })).status, 429);
});

test("TRUST_PROXY and limit settings accept only sensible whole numbers", () => {
  assert.equal(readTrustProxy(undefined, silent), false);
  assert.equal(readTrustProxy("", silent), false);
  assert.equal(readTrustProxy("1", silent), 1);
  assert.equal(readTrustProxy("true", silent), false, "true would trust any forwarded address");
  assert.equal(readTrustProxy("0", silent), false);
  assert.equal(readTrustProxy("11", silent), false);

  assert.equal(readLimit(undefined, 200, "X", silent), 200);
  assert.equal(readLimit("50", 200, "X", silent), 50);
  assert.equal(readLimit("0", 200, "X", silent), 200);
  assert.equal(readLimit("-5", 200, "X", silent), 200);
  assert.equal(readLimit("1.5", 200, "X", silent), 200);
  assert.equal(readLimit("lots", 200, "X", silent), 200);
});
