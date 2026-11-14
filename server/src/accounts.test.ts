// Unit tests for the account building blocks that need no database:
// password hashing, permissions, session cookies, audit metadata, and the
// PayPal subscription client (with a fake PayPal; nothing is sent anywhere).
import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, passwordProblem, verifyPassword, DEFAULT_SCRYPT_PARAMS } from "./passwords.js";
import { ROLE_PERMISSIONS, permissionsFor } from "./permissions.js";
import {
  createSessionToken,
  hashSessionToken,
  isWellFormedSessionToken,
  readCookie,
  readSessionCookieConfig,
  serializeSessionCookie,
} from "./auth.js";
import { safeMetadata } from "./auditLog.js";
import {
  SUBSCRIPTION_OFFER,
  createPayPalSubscription,
  getPayPalSaleSubscriptionId,
  getPayPalSubscription,
  isPayPalCertUrl,
  planDefinition,
  planProblems,
  readWebhookHeaders,
  toSnapshot,
  verifyWebhookSignature,
} from "./paypalSubscriptions.js";

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const silent = { error() {}, warn() {} };

// ---- Passwords ----------------------------------------------------------------

test("scrypt hashes verify only the right password, record their parameters, and are salted", async () => {
  const hash = await hashPassword("correct horse battery staple");
  assert.match(hash, new RegExp(`^scrypt\\$${DEFAULT_SCRYPT_PARAMS.N}\\$8\\$1\\$[A-Za-z0-9_-]{22}\\$[A-Za-z0-9_-]{86}$`));
  assert.ok(!hash.includes("correct horse"));
  assert.equal(await verifyPassword("correct horse battery staple", hash), true);
  assert.equal(await verifyPassword("correct horse battery stapl", hash), false);
  assert.notEqual(await hashPassword("correct horse battery staple", FAST), await hashPassword("correct horse battery staple", FAST));
});

test("malformed or tampered stored hashes never verify", async () => {
  const hash = await hashPassword("a long enough password", FAST);
  for (const bad of ["", "plain-text-password", hash.replace("scrypt$", "md5$"), hash.slice(0, -4), "scrypt$99999999$8$1$AAAA$BBBB"]) {
    assert.equal(await verifyPassword("a long enough password", bad), false, bad.slice(0, 20));
  }
});

test("password rules: length limits, predictability, and not the email address", () => {
  assert.match(passwordProblem("short", "a@b.co")!, /at least 12/);
  assert.match(passwordProblem("x".repeat(129), "a@b.co")!, /at most 128/);
  assert.match(passwordProblem("aaaaaaaaaaaaaa", "a@b.co")!, /predictable/);
  assert.match(passwordProblem("someone@example.com", "someone@example.com")!, /email/);
  assert.equal(passwordProblem("purple-tractor-41-river", "a@b.co"), undefined);
});

// ---- Permissions --------------------------------------------------------------

test("users get proposal and subscription permissions but no admin permission", () => {
  const user = permissionsFor(["user"]);
  for (const permission of ["proposal:create", "proposal:review", "subscription:read", "subscription:manage"] as const) {
    assert.ok(user.has(permission), permission);
  }
  for (const permission of ["admin:users:read", "admin:users:update", "admin:audit:read"] as const) {
    assert.ok(!user.has(permission), permission);
  }
});

test("admins have every user permission plus the admin ones; unknown roles grant nothing", () => {
  const admin = permissionsFor(["admin"]);
  for (const permission of ROLE_PERMISSIONS.user) assert.ok(admin.has(permission), permission);
  assert.ok(admin.has("admin:users:update") && admin.has("admin:audit:read"));
  assert.equal(permissionsFor(["superuser", "ADMIN", ""]).size, 0);
});

// ---- Session cookies ----------------------------------------------------------

test("session tokens are 256-bit, random, and only their SHA-256 hash is meant for storage", () => {
  const first = createSessionToken();
  const second = createSessionToken();
  assert.ok(isWellFormedSessionToken(first.token));
  assert.notEqual(first.token, second.token);
  assert.equal(first.hash, hashSessionToken(first.token));
  assert.match(first.hash, /^[0-9a-f]{64}$/);
  assert.ok(!isWellFormedSessionToken(first.hash));
});

test("local defaults: SameSite=Lax, not Secure, 7 days", () => {
  const config = readSessionCookieConfig({}, silent);
  assert.deepEqual(config, { name: "paypilot_session", secure: false, sameSite: "Lax", partitioned: false, ttlMs: 168 * 3_600_000 });
});

test("production defaults: a __Host- cookie that is Secure, SameSite=None and Partitioned", () => {
  const config = readSessionCookieConfig({ NODE_ENV: "production" }, silent);
  assert.equal(config.name, "__Host-paypilot_session");
  assert.equal(config.secure, true);
  assert.equal(config.sameSite, "None");
  assert.equal(config.partitioned, true);
  const header = serializeSessionCookie(config, "abc", 60);
  for (const part of ["__Host-paypilot_session=abc", "Path=/", "HttpOnly", "SameSite=None", "Max-Age=60", "Secure", "Partitioned"]) {
    assert.ok(header.split("; ").includes(part), part);
  }
  assert.ok(!/Domain=/i.test(header));
});

test("SameSite=None always forces a Secure cookie; invalid settings keep the safe defaults", () => {
  const errors: string[] = [];
  const logger = { error: (...args: unknown[]) => void errors.push(String(args[0])) };
  assert.equal(readSessionCookieConfig({ SESSION_COOKIE_SAMESITE: "none", SESSION_COOKIE_SECURE: "false" }, logger).secure, true);
  const fallback = readSessionCookieConfig({ SESSION_COOKIE_SAMESITE: "loose", SESSION_TTL_HOURS: "9999" }, logger);
  assert.equal(fallback.sameSite, "Lax");
  assert.equal(fallback.ttlMs, 168 * 3_600_000);
  assert.equal(errors.length, 3);
});

test("readCookie finds the session cookie among others", () => {
  assert.equal(readCookie("a=1; paypilot_session=tok; b=2", "paypilot_session"), "tok");
  assert.equal(readCookie("xpaypilot_session=tok", "paypilot_session"), undefined);
  assert.equal(readCookie(undefined, "paypilot_session"), undefined);
});

// ---- Audit metadata -----------------------------------------------------------

test("audit metadata keeps only allowed, short, non-secret values", () => {
  const safe = safeMetadata({
    reason: "wrong_password",
    password: "hunter2hunter2",
    token: "abc",
    sessionToken: "abc",
    authorization: "Bearer x",
    status: "ACTIVE",
    nested: { secret: "x" },
    previousRoles: ["user"],
    path: "x".repeat(500),
  });
  assert.deepEqual(Object.keys(safe).sort(), ["path", "previousRoles", "reason", "status"]);
  assert.equal((safe.path as string).length, 200);
});

// ---- PayPal subscription client -------------------------------------------------

function validPlan() {
  return { id: "P-TEST", ...planDefinition("PROD-TEST") };
}

test("the plan definition is a 7-day free trial, then USD 5.00 every month until cancelled", () => {
  const plan = planDefinition("PROD-1");
  const [trial, regular] = plan.billing_cycles;
  assert.equal(trial!.tenure_type, "TRIAL");
  assert.deepEqual(trial!.frequency, { interval_unit: "DAY", interval_count: 7 });
  assert.equal(trial!.total_cycles, 1);
  assert.ok(!("pricing_scheme" in trial!), "a free trial has no price");
  assert.equal(regular!.tenure_type, "REGULAR");
  assert.deepEqual(regular!.frequency, { interval_unit: "MONTH", interval_count: 1 });
  assert.equal(regular!.total_cycles, 0);
  assert.deepEqual(regular!.pricing_scheme, { fixed_price: { value: "5.00", currency_code: "USD" } });
  assert.deepEqual(planProblems(validPlan()), []);
  assert.deepEqual(SUBSCRIPTION_OFFER, { price: "5.00", currency: "USD", interval: "MONTH", intervalCount: 1, trialDays: 7 });
});

test("plans that differ from the offer are detected", () => {
  const variants: Array<[string, (plan: ReturnType<typeof validPlan>) => unknown]> = [
    ["inactive", (plan) => ({ ...plan, status: "INACTIVE" })],
    ["no trial", (plan) => ({ ...plan, billing_cycles: [plan.billing_cycles[1]] })],
    ["14-day trial", (plan) => ({ ...plan, billing_cycles: [{ ...plan.billing_cycles[0], frequency: { interval_unit: "DAY", interval_count: 14 } }, plan.billing_cycles[1]] })],
    ["paid trial", (plan) => ({ ...plan, billing_cycles: [{ ...plan.billing_cycles[0], pricing_scheme: { fixed_price: { value: "1.00", currency_code: "USD" } } }, plan.billing_cycles[1]] })],
    ["USD 9", (plan) => ({ ...plan, billing_cycles: [plan.billing_cycles[0], { ...plan.billing_cycles[1], pricing_scheme: { fixed_price: { value: "9.00", currency_code: "USD" } } }] })],
    ["EUR", (plan) => ({ ...plan, billing_cycles: [plan.billing_cycles[0], { ...plan.billing_cycles[1], pricing_scheme: { fixed_price: { value: "5.00", currency_code: "EUR" } } }] })],
    ["yearly", (plan) => ({ ...plan, billing_cycles: [plan.billing_cycles[0], { ...plan.billing_cycles[1], frequency: { interval_unit: "YEAR", interval_count: 1 } }] })],
    ["12 payments only", (plan) => ({ ...plan, billing_cycles: [plan.billing_cycles[0], { ...plan.billing_cycles[1], total_cycles: 12 }] })],
    ["setup fee", (plan) => ({ ...plan, payment_preferences: { ...plan.payment_preferences, setup_fee: { value: "2", currency_code: "USD" } } })],
  ];
  for (const [label, change] of variants) {
    assert.ok(planProblems(change(validPlan())).length > 0, label);
  }
  assert.ok(planProblems(undefined).length > 0);
});

function recordingFetch(reply: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  return {
    calls,
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return reply(url, init);
    },
  };
}
const deps = (fetch: (url: string, init: RequestInit) => Promise<Response>) => ({
  fetch,
  baseUrl: "https://api-m.sandbox.paypal.com",
  getAccessToken: async () => "ACCESS-TOKEN",
});

test("creating a subscription sends the plan, the internal id as custom_id and idempotency key, and the return URLs", async () => {
  const paypal = recordingFetch(
    () =>
      new Response(
        JSON.stringify({
          id: "I-ABC123456",
          status: "APPROVAL_PENDING",
          create_time: "2026-11-11T10:00:00Z",
          links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-1" }],
        }),
        { status: 201 },
      ),
  );
  const result = await createPayPalSubscription(deps(paypal.fetch), {
    planId: "P-TEST",
    customId: "0b8f9b4e-0000-4000-8000-000000000001",
    returnUrl: "https://app.example/?subscription=return",
    cancelUrl: "https://app.example/?subscription=cancel",
  });
  const { url, init } = paypal.calls[0]!;
  assert.equal(url, "https://api-m.sandbox.paypal.com/v1/billing/subscriptions");
  assert.equal(init.method, "POST");
  const headers = init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer ACCESS-TOKEN");
  assert.equal(headers["PayPal-Request-Id"], "0b8f9b4e-0000-4000-8000-000000000001");
  const body = JSON.parse(String(init.body));
  assert.equal(body.plan_id, "P-TEST");
  assert.equal(body.custom_id, "0b8f9b4e-0000-4000-8000-000000000001");
  assert.equal(body.application_context.return_url, "https://app.example/?subscription=return");
  assert.equal(body.application_context.cancel_url, "https://app.example/?subscription=cancel");
  assert.equal(result.snapshot.status, "APPROVAL_PENDING");
  assert.equal(result.approveUrl, "https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-1");
});

test("subscription snapshots keep the fields entitlement depends on and refuse unknown statuses", async () => {
  const snapshot = toSnapshot({
    id: "I-ABC123456",
    status: "ACTIVE",
    plan_id: "P-TEST",
    custom_id: "row-1",
    status_update_time: "2026-11-11T10:05:00Z",
    billing_info: { next_billing_time: "2026-11-18T10:00:00Z" },
  });
  assert.equal(snapshot.status, "ACTIVE");
  assert.equal(snapshot.statusUpdateTime?.toISOString(), "2026-11-11T10:05:00.000Z");
  assert.equal(snapshot.nextBillingTime?.toISOString(), "2026-11-18T10:00:00.000Z");
  assert.throws(() => toSnapshot({ id: "I-ABC123456", status: "PAID" }));
  const missing = recordingFetch(() => new Response("{}", { status: 404 }));
  await assert.rejects(getPayPalSubscription(deps(missing.fetch), "I-ABC123456"), (error: Error & { paypalStatus?: number }) => {
    assert.equal(error.paypalStatus, 404);
    assert.ok(!("status" in error), "no `status` property that the error handler would forward");
    return true;
  });
});

test("webhook verification passes the raw event bytes unchanged and checks PayPal's answer", async () => {
  const rawBody = '{"id":"WH-1",  "event_type":"BILLING.SUBSCRIPTION.ACTIVATED","resource":{"id":"I-ABC123456","amount":1.50}}';
  const headers = readWebhookHeaders(
    (name) =>
      ({
        "paypal-auth-algo": "SHA256withRSA",
        "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
        "paypal-transmission-id": "tx-1",
        "paypal-transmission-sig": "sig==",
        "paypal-transmission-time": "2026-11-11T10:00:00Z",
      })[name],
  )!;
  for (const answer of ["SUCCESS", "FAILURE"]) {
    const paypal = recordingFetch(() => new Response(JSON.stringify({ verification_status: answer })));
    const genuine = await verifyWebhookSignature(deps(paypal.fetch), { headers, rawBody, webhookId: "WH-ID" });
    assert.equal(genuine, answer === "SUCCESS");
    const sent = String(paypal.calls[0]!.init.body);
    assert.ok(sent.endsWith(`"webhook_event":${rawBody}}`), "the event is embedded byte for byte");
    const parsed = JSON.parse(sent);
    assert.equal(parsed.webhook_id, "WH-ID");
    assert.equal(parsed.transmission_sig, "sig==");
    assert.equal(paypal.calls[0]!.url, "https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature");
  }
});

test("a webhook whose certificate is not on paypal.com is refused without asking PayPal", async () => {
  assert.equal(isPayPalCertUrl("https://api.paypal.com/v1/notifications/certs/X"), true);
  for (const bad of ["http://api.paypal.com/c", "https://paypal.com.evil.example/c", "https://evilpaypal.com/c", "not a url"]) {
    assert.equal(isPayPalCertUrl(bad), false, bad);
  }
  const paypal = recordingFetch(() => new Response(JSON.stringify({ verification_status: "SUCCESS" })));
  const genuine = await verifyWebhookSignature(deps(paypal.fetch), {
    headers: { authAlgo: "SHA256withRSA", certUrl: "https://evil.example/cert", transmissionId: "t", transmissionSig: "s", transmissionTime: "x" },
    rawBody: "{}",
    webhookId: "WH-ID",
  });
  assert.equal(genuine, false);
  assert.equal(paypal.calls.length, 0);
  assert.equal(readWebhookHeaders(() => undefined), undefined);
});

test("a sale is linked to its subscription only through PayPal's own sale record", async () => {
  const sale = recordingFetch(() => new Response(JSON.stringify({ id: "SALE123456", state: "refunded", billing_agreement_id: "I-ABC123456" })));
  assert.equal(await getPayPalSaleSubscriptionId(deps(sale.fetch), "SALE123456"), "I-ABC123456");
  assert.equal(sale.calls[0]!.url, "https://api-m.sandbox.paypal.com/v1/payments/sale/SALE123456");
  assert.equal(sale.calls[0]!.init.method, "GET");

  // Not a subscription payment, or unknown to PayPal: no subscription.
  const oneTime = recordingFetch(() => new Response(JSON.stringify({ id: "SALE123456", state: "completed" })));
  assert.equal(await getPayPalSaleSubscriptionId(deps(oneTime.fetch), "SALE123456"), undefined);
  const missing = recordingFetch(() => new Response("{}", { status: 404 }));
  assert.equal(await getPayPalSaleSubscriptionId(deps(missing.fetch), "SALE123456"), undefined);

  // Any other failure is an error, so the webhook is retried later.
  const down = recordingFetch(() => new Response("{}", { status: 503 }));
  await assert.rejects(getPayPalSaleSubscriptionId(deps(down.fetch), "SALE123456"), /HTTP 503/);
});
