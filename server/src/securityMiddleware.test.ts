// Regression tests for request hardening, using the same middleware order as
// index.ts: security headers, CORS, origin check, JSON-only bodies, the JSON
// parser, routes, the JSON 404, and the JSON error handler.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import cors from "cors";
import {
  corsOptions,
  FORBIDDEN_ORIGIN_ERROR,
  JSON_REQUIRED_ERROR,
  notFoundHandler,
  rejectDisallowedOrigins,
  requireJsonBody,
  securityHeaders,
} from "./securityMiddleware.js";
import { jsonErrorHandler } from "./httpErrors.js";

const ALLOWED = "https://app.example";

async function startApi(t: TestContext) {
  const calls: unknown[] = [];
  const app = express();
  app.disable("x-powered-by");
  app.use(securityHeaders);
  app.use(cors(corsOptions([ALLOWED])));
  app.use(rejectDisallowedOrigins([ALLOWED]));
  app.use(requireJsonBody);
  app.use(express.json({ limit: "100kb" }));
  app.post("/api/work", (req, res) => {
    calls.push(req.body);
    res.json({ ok: true, polluted: ({} as Record<string, unknown>).polluted ?? null });
  });
  app.get("/api/status", (_req, res) => {
    calls.push("status");
    res.json({ ok: true });
  });
  app.use(notFoundHandler);
  app.use(jsonErrorHandler);

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls };
}

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
});

test("responses carry security headers and no X-Powered-By", async (t) => {
  const { base } = await startApi(t);
  const response = await fetch(`${base}/api/status`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-powered-by"), null);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.match(response.headers.get("strict-transport-security") ?? "", /max-age=\d+/);
});

test("the allowed frontend origin gets CORS access", async (t) => {
  const { base, calls } = await startApi(t);
  const response = await fetch(`${base}/api/work`, json({ a: 1 }, { Origin: ALLOWED }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), ALLOWED);
  assert.equal(calls.length, 1);
});

test("a request from another origin is refused before the route runs", async (t) => {
  const { base, calls } = await startApi(t);
  for (const origin of ["https://evil.example", "null", `${ALLOWED}.evil.example`, "http://app.example"]) {
    const response = await fetch(`${base}/api/work`, json({ a: 1 }, { Origin: origin }));
    assert.equal(response.status, 403, origin);
    assert.equal(response.headers.get("access-control-allow-origin"), null, origin);
    assert.deepEqual(await response.json(), { error: FORBIDDEN_ORIGIN_ERROR });
  }
  const get = await fetch(`${base}/api/status`, { headers: { Origin: "https://evil.example" } });
  assert.equal(get.status, 403);
  assert.deepEqual(calls, []);
});

test("a preflight from another origin gets no CORS permission", async (t) => {
  const { base } = await startApi(t);
  const response = await fetch(`${base}/api/work`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://evil.example",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("requests without an Origin header (curl, server-to-server) are allowed through", async (t) => {
  const { base, calls } = await startApi(t);
  const response = await fetch(`${base}/api/work`, json({ a: 1 }));
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
});

test("a POST that isn't JSON is refused with 415, so a cross-site form or text/plain POST can't run it", async (t) => {
  const { base, calls } = await startApi(t);
  const attempts: RequestInit[] = [
    { method: "POST" },
    { method: "POST", headers: { "Content-Type": "text/plain" }, body: '{"a":1}' },
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "a=1" },
    { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=x" }, body: "--x--" },
  ];
  for (const init of attempts) {
    const response = await fetch(`${base}/api/work`, init);
    assert.equal(response.status, 415);
    assert.deepEqual(await response.json(), { error: JSON_REQUIRED_ERROR });
  }
  assert.deepEqual(calls, []);
});

test("JSON with a charset is accepted", async (t) => {
  const { base } = await startApi(t);
  const response = await fetch(`${base}/api/work`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: "{}",
  });
  assert.equal(response.status, 200);
});

test("invalid JSON and oversized bodies get short JSON errors", async (t) => {
  const { base, calls } = await startApi(t);
  const invalid = await fetch(`${base}/api/work`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"brief": ',
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "The request body is not valid JSON." });

  const oversized = await fetch(`${base}/api/work`, json({ brief: "x".repeat(150_000) }));
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), { error: "The request is too large." });
  assert.deepEqual(calls, []);
});

test("a __proto__ key in a JSON body does not pollute other objects", async (t) => {
  const { base } = await startApi(t);
  const response = await fetch(`${base}/api/work`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"__proto__": {"polluted": "yes"}, "constructor": {"prototype": {"polluted": "yes"}}}',
  });
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { polluted: unknown }).polluted, null);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("unknown routes get a JSON 404 instead of Express's HTML page", async (t) => {
  const { base } = await startApi(t);
  const response = await fetch(`${base}/does-not-exist`);
  assert.equal(response.status, 404);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), { error: "Not found." });
  assert.doesNotMatch(text, /Cannot GET|<html|<pre/i);
});

test("a preflight from the allowed origin permits only GET, POST, PUT, PATCH, and the headers the frontend sends", async (t) => {
  const { base } = await startApi(t);
  const response = await fetch(`${base}/api/payments/orders/X`, {
    method: "OPTIONS",
    headers: {
      Origin: ALLOWED,
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "x-checkout-token",
    },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), ALLOWED);
  assert.equal(response.headers.get("access-control-allow-methods"), "GET,POST,PUT,PATCH", "no DELETE or other methods");
  assert.equal(response.headers.get("access-control-allow-headers"), "Content-Type,X-Checkout-Token");
  // The session cookie needs credentialed CORS, but only for this exact
  // origin: never with a wildcard.
  assert.equal(response.headers.get("access-control-allow-credentials"), "true");
  assert.notEqual(response.headers.get("access-control-allow-origin"), "*");
});

test("credentials are never granted to a foreign origin", async (t) => {
  const { base } = await startApi(t);
  const preflight = await fetch(`${base}/api/work`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://evil.example",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  // No Allow-Origin, so the browser refuses the preflight and never sends a
  // credentialed request. (The cors package adds Allow-Credentials to every
  // response; without a matching Allow-Origin it grants nothing.)
  assert.equal(preflight.headers.get("access-control-allow-origin"), null);
  const get = await fetch(`${base}/api/status`, { headers: { Origin: "https://evil.example", Cookie: "paypilot_session=x" } });
  assert.equal(get.status, 403);
  assert.equal(get.headers.get("access-control-allow-origin"), null);
});

test("CORS never reflects an arbitrary origin, even one that only differs slightly", async (t) => {
  const { base } = await startApi(t);
  for (const origin of [`${ALLOWED}/`, "HTTPS://APP.EXAMPLE", "https://app.example:443.evil.example"]) {
    const response = await fetch(`${base}/api/status`, { headers: { Origin: origin } });
    assert.notEqual(response.headers.get("access-control-allow-origin"), origin, origin);
    assert.equal(response.status, 403, origin);
  }
});
