// Regression tests for security-relevant configuration: allowed origins,
// the Sandbox-only PayPal URL, and cached health checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClientOrigins, readPayPalBaseUrl, PAYPAL_SANDBOX_URL } from "./config.js";
import { createCachedCheck } from "./healthCache.js";

function quietLogger() {
  const errors: string[] = [];
  return { errors, logger: { error: (...args: unknown[]) => errors.push(args.join(" ")) } };
}

test("CLIENT_ORIGINS keeps exact origins only and never widens the list", () => {
  const { errors, logger } = quietLogger();
  const origins = parseClientOrigins(
    " https://rapid-fire-08f4.namanshahnemi.workers.dev , https://app.example/ , *, https://app.example/path, ftp://files.example, not a url, http://localhost:5173, http://localhost:5173",
    logger,
  );
  assert.deepEqual(origins, ["https://rapid-fire-08f4.namanshahnemi.workers.dev", "http://localhost:5173"]);
  assert.equal(errors.length, 5, "each rejected entry is reported");
  assert.ok(errors.every((line) => /ignored/.test(line)));
});

test("an unset CLIENT_ORIGINS allows only the local development origins", () => {
  assert.deepEqual(parseClientOrigins(undefined), ["http://localhost:5173", "http://localhost:5174"]);
});

test("a CLIENT_ORIGINS with no valid entry allows no browser origin at all", () => {
  const { errors, logger } = quietLogger();
  assert.deepEqual(parseClientOrigins("*", logger), []);
  assert.ok(errors.some((line) => /no valid origins/.test(line)));
});

test("PAYPAL_BASE_URL accepts only the PayPal Sandbox API", () => {
  assert.equal(readPayPalBaseUrl(undefined), PAYPAL_SANDBOX_URL);
  assert.equal(readPayPalBaseUrl(""), PAYPAL_SANDBOX_URL);
  assert.equal(readPayPalBaseUrl("https://api-m.sandbox.paypal.com"), PAYPAL_SANDBOX_URL);
  assert.equal(readPayPalBaseUrl("https://api-m.sandbox.paypal.com/"), PAYPAL_SANDBOX_URL);
  for (const live of [
    "https://api-m.paypal.com",
    "https://api.paypal.com",
    "http://api-m.sandbox.paypal.com",
    "https://api-m.sandbox.paypal.com.evil.example",
    "https://api-m.sandbox.paypal.com/v2",
    "not a url",
  ]) {
    assert.throws(() => readPayPalBaseUrl(live), /Sandbox|valid URL/, live);
  }
});

test("a cached health check calls the outside service at most once per TTL", async () => {
  let time = 0;
  let calls = 0;
  const check = createCachedCheck(
    async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { status: 200, body: { status: "ok", call: calls } };
    },
    { ttlMs: 60_000, now: () => time },
  );

  // Concurrent requests share one check.
  const results = await Promise.all([check(), check(), check()]);
  assert.equal(calls, 1);
  assert.ok(results.every((result) => result.body.call === 1));

  time = 59_000;
  assert.equal((await check()).body.call, 1, "served from cache");
  assert.equal(calls, 1);

  time = 60_001;
  assert.equal((await check()).body.call, 2, "refreshed after the TTL");
});

test("a failing or throwing health check is cached too, so failures can't be hammered", async () => {
  let calls = 0;
  const check = createCachedCheck(
    async () => {
      calls++;
      throw new Error("secret detail that must not be returned");
    },
    { ttlMs: 60_000, now: () => 0 },
  );
  const first = await check();
  const second = await check();
  assert.equal(calls, 1);
  assert.equal(first.status, 503);
  assert.ok(!JSON.stringify(second.body).includes("secret detail"));
});
