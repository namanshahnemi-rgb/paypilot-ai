// Regression tests: malformed or oversized request bodies, and unexpected
// route errors, must return short JSON errors without stack traces or paths.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { jsonErrorHandler } from "./httpErrors.js";

async function startApi(t: TestContext) {
  const app = express();
  app.use(express.json({ limit: "100kb" }));
  app.post("/echo", (req, res) => {
    res.json({ received: req.body });
  });
  app.get("/boom", () => {
    throw new Error("secret internal detail at E:\\Projects\\file.ts");
  });
  app.use(jsonErrorHandler);

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function call(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const text = await response.text();
  return { status: response.status, type: response.headers.get("content-type") ?? "", text };
}

const post = (body: string) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body,
});

test("malformed JSON bodies get a 400 JSON error without a stack trace", async (t) => {
  const base = await startApi(t);
  const result = await call(`${base}/echo`, post('{"brief": broken'));

  assert.equal(result.status, 400);
  assert.match(result.type, /application\/json/);
  assert.deepEqual(JSON.parse(result.text), { error: "The request body is not valid JSON." });
  assert.doesNotMatch(result.text, /at |node_modules|<html/i);
});

test("oversized bodies get a 413 JSON error", async (t) => {
  const base = await startApi(t);
  const result = await call(`${base}/echo`, post(JSON.stringify({ brief: "x".repeat(120_000) })));

  assert.equal(result.status, 413);
  assert.deepEqual(JSON.parse(result.text), { error: "The request is too large." });
});

test("unexpected route errors get a generic 500 JSON error", async (t) => {
  const base = await startApi(t);
  t.mock.method(console, "error", () => {});
  const result = await call(`${base}/boom`);

  assert.equal(result.status, 500);
  assert.deepEqual(JSON.parse(result.text), {
    error: "Something went wrong on the server. Try again.",
  });
  assert.doesNotMatch(result.text, /secret|Projects/);
});

test("valid requests are unaffected", async (t) => {
  const base = await startApi(t);
  const result = await call(`${base}/echo`, post('{"ok":true}'));

  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.text), { received: { ok: true } });
});
