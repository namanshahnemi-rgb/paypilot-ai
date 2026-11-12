// PostgreSQL integration tests for accounts, sessions, RBAC, audit logs,
// subscriptions and PayPal webhooks, through the real routers and middleware.
//
// Isolation: every run creates its own schema (itest_accounts_<random>),
// points a dedicated pool at it with search_path, and drops it at the end.
// No other schema or table in the database is read or changed.
//
// PayPal is a scripted fake: no request leaves this process and no payment
// or subscription is created anywhere. Run with `npm run test:integration`.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import type { Pool } from "pg";
import { createPostgresPool, PostgresOrderRegistry } from "./postgresOrderRegistry.js";
import { ACCOUNT_MIGRATIONS, migrateAccountSchema } from "./accountSchema.js";
import { createAuthModule, readSessionCookieConfig, type AuthModule } from "./auth.js";
import { createSubscriptionModule, keepRawWebhookBody, type SubscriptionModule } from "./subscriptions.js";
import { createAdminRouter } from "./adminRoutes.js";
import { createUsageModule, type UsageModule } from "./usage.js";
import { createProjectRouter } from "./projects.js";
import { planDefinition } from "./paypalSubscriptions.js";
import { corsOptions, notFoundHandler, rejectDisallowedOrigins, requireJsonBody, securityHeaders } from "./securityMiddleware.js";
import { jsonErrorHandler } from "./httpErrors.js";

dotenv.config({ quiet: true });

const DATABASE_URL = process.env.DATABASE_URL?.trim() ?? "";
const ALLOW_SKIP = process.env.PG_INTEGRATION_ALLOW_SKIP === "1";
const SCHEMA = `itest_accounts_${randomBytes(4).toString("hex")}`;
const ORIGIN = "https://app.example";
const PLAN_ID = "P-TESTPLAN";
const WEBHOOK_ID = "WH-TEST-ID";
const ADMIN_EMAIL = "admin@paypilot.test";
const ADMIN_PASSWORD = "admin-bootstrap-password-1";
const PASSWORD = "purple-tractor-41-river";
const silent = { error() {}, warn() {} };

let unavailable: string | undefined = DATABASE_URL ? undefined : "DATABASE_URL is not set";
let adminPool: Pool | undefined;
let pool: Pool | undefined;
let server: Server | undefined;
let base = "";
let clock = Date.parse("2026-11-11T10:00:00Z");
let auth: AuthModule;
let subscriptions: SubscriptionModule;
let usage: UsageModule;

// ---- Fake PayPal ------------------------------------------------------------

type FakeSubscription = {
  id: string;
  status: string;
  plan_id: string;
  custom_id: string;
  create_time: string;
  status_update_time: string;
  billing_info?: { next_billing_time: string };
};

const paypal = {
  plan: { id: PLAN_ID, ...planDefinition("PROD-TEST") } as Record<string, unknown>,
  subscriptions: new Map<string, FakeSubscription>(),
  verification: "SUCCESS",
  calls: [] as Array<{ method: string; path: string; body: string | undefined }>,
  counter: 0,
  tick: Date.parse("2026-11-11T10:00:00Z"),
  setStatus(id: string, status: string) {
    const sub = this.subscriptions.get(id)!;
    this.tick += 1000;
    sub.status = status;
    sub.status_update_time = new Date(this.tick).toISOString();
    if (status === "ACTIVE") sub.billing_info = { next_billing_time: "2026-11-18T10:00:00Z" };
  },
  count(method: string, prefix: string) {
    return this.calls.filter((call) => call.method === method && call.path.startsWith(prefix)).length;
  },
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function fakePayPalFetch(url: string, init: RequestInit): Promise<Response> {
  const { pathname } = new URL(url);
  const method = init.method ?? "GET";
  const body = init.body === undefined ? undefined : String(init.body);
  paypal.calls.push({ method, path: pathname, body });
  if (method === "GET" && pathname === `/v1/billing/plans/${PLAN_ID}`) return json(200, paypal.plan);
  if (method === "POST" && pathname === "/v1/billing/subscriptions") {
    const request = JSON.parse(body!);
    const id = `I-TESTSUB${String(++paypal.counter).padStart(4, "0")}`;
    paypal.tick += 1000;
    const created: FakeSubscription = {
      id,
      status: "APPROVAL_PENDING",
      plan_id: request.plan_id,
      custom_id: request.custom_id,
      create_time: new Date(paypal.tick).toISOString(),
      status_update_time: new Date(paypal.tick).toISOString(),
    };
    paypal.subscriptions.set(id, created);
    return json(201, {
      ...created,
      links: [{ rel: "approve", href: `https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-${paypal.counter}` }],
    });
  }
  const subscription = /^\/v1\/billing\/subscriptions\/([^/]+)(\/cancel)?$/.exec(pathname);
  if (subscription) {
    const sub = paypal.subscriptions.get(decodeURIComponent(subscription[1]!));
    if (!sub) return json(404, { name: "RESOURCE_NOT_FOUND" });
    if (subscription[2] && method === "POST") {
      paypal.setStatus(sub.id, "CANCELLED");
      return new Response(null, { status: 204 });
    }
    return json(200, sub);
  }
  if (method === "POST" && pathname === "/v1/notifications/verify-webhook-signature") {
    return json(200, { verification_status: paypal.verification });
  }
  return json(404, { name: "NOT_FOUND" });
}

// ---- App under test -----------------------------------------------------------

before(async () => {
  if (unavailable) return;
  adminPool = createPostgresPool(DATABASE_URL, { max: 2, connectionTimeoutMillis: 5000, application_name: `${SCHEMA}-admin` });
  try {
    await adminPool.query(`CREATE SCHEMA ${SCHEMA}`);
  } catch (error) {
    unavailable = `PostgreSQL is not reachable (${error instanceof Error ? error.message : "unknown error"})`;
    await adminPool.end().catch(() => undefined);
    adminPool = undefined;
    return;
  }
  pool = createPostgresPool(DATABASE_URL, { max: 5, application_name: SCHEMA, options: `-c search_path=${SCHEMA}` });
  await new PostgresOrderRegistry(pool).initialize();
  await migrateAccountSchema(pool);

  const now = () => clock;
  auth = createAuthModule({
    pool,
    allowedOrigins: [ORIGIN],
    cookie: readSessionCookieConfig({ SESSION_TTL_HOURS: "1" }, silent),
    now,
    passwordParams: { N: 2 ** 10, r: 8, p: 1 },
    limits: { registerPerHourPerClient: 1000, loginPer10MinutesPerClient: 1000, failedLoginsPerEmail: 5 },
    logger: silent,
  });
  await auth.bootstrapAdmin(ADMIN_EMAIL, ADMIN_PASSWORD);
  subscriptions = createSubscriptionModule({
    pool,
    auth,
    payPal: { fetch: fakePayPalFetch, baseUrl: "https://api-m.sandbox.paypal.com", getAccessToken: async () => "FAKE-TOKEN" },
    planId: PLAN_ID,
    webhookId: WEBHOOK_ID,
    allowedOrigins: [ORIGIN],
    now,
    limits: { createPer10MinutesPerClient: 1000 },
    logger: silent,
  });

  // The same middleware order as index.ts.
  const app = express();
  app.use(securityHeaders);
  app.use(cors(corsOptions([ORIGIN])));
  app.use(rejectDisallowedOrigins([ORIGIN]));
  app.use(requireJsonBody);
  app.use(express.json({ limit: "100kb", verify: keepRawWebhookBody }));
  app.use(auth.authenticate);
  app.use(auth.router);
  app.use(subscriptions.router);
  app.use(createAdminRouter({ pool, auth }));
  usage = createUsageModule({ pool, auth, hasActiveSubscription: subscriptions.hasActiveSubscription, now, logger: silent });
  app.use(usage.router);
  app.use(createProjectRouter({ pool, auth, requireEntitlement: subscriptions.requireEntitlement }));
  // The same guards as the three AI routes in index.ts.
  const canAnalyze = [auth.requireUser, auth.requirePermission("proposal:create"), usage.analysisQuota];
  const canCreate = [auth.requireUser, auth.requirePermission("proposal:create"), subscriptions.requireEntitlement];
  const canReview = [auth.requireUser, auth.requirePermission("proposal:review"), subscriptions.requireEntitlement];
  app.post("/api/proposals/analyze", ...canAnalyze, (req, res) => {
    // A test hook for the refund rule: { fail: true } simulates an AI error.
    if ((req.body as { fail?: boolean })?.fail) return void res.status(502).json({ error: "AI failed" });
    res.json({ analysis: "ran" });
  });
  app.post("/api/proposals/draft", ...canCreate, (_req, res) => {
    res.json({ proposal: "ran" });
  });
  app.post("/api/proposals/review", ...canReview, (_req, res) => {
    res.json({ findings: [] });
  });
  app.use(notFoundHandler);
  app.use(jsonErrorHandler);
  server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server!.close(resolve));
  await pool?.end().catch(() => undefined);
  if (adminPool) {
    await adminPool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await adminPool.end();
  }
});

function dbTest(name: string, fn: () => Promise<void>) {
  test(name, { skip: unavailable && ALLOW_SKIP ? `${unavailable}; PG_INTEGRATION_ALLOW_SKIP=1` : false, timeout: 30_000 }, async () => {
    if (unavailable || !pool) throw new Error(`${unavailable ?? "PostgreSQL is not available"}. Set PG_INTEGRATION_ALLOW_SKIP=1 to skip.`);
    await fn();
  });
}

// ---- HTTP helpers -------------------------------------------------------------

type Browser = { cookie: string | undefined };

async function call(
  browser: Browser | undefined,
  method: string,
  path: string,
  body?: unknown,
  extra: Record<string, string | null> = {},
) {
  const headers: Record<string, string> = { Origin: ORIGIN };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (browser?.cookie) headers.Cookie = browser.cookie;
  for (const [name, value] of Object.entries(extra)) {
    if (value === null) delete headers[name];
    else headers[name] = value;
  }
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
  const setCookie = response.headers.get("set-cookie");
  if (browser && setCookie) {
    const value = setCookie.split(";")[0]!;
    browser.cookie = value.endsWith("=") ? undefined : value;
  }
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, any>, setCookie };
}

let emailCounter = 0;
const newEmail = () => `user${++emailCounter}-${randomBytes(3).toString("hex")}@paypilot.test`;

async function registered(email = newEmail()) {
  const browser: Browser = { cookie: undefined };
  const result = await call(browser, "POST", "/api/auth/register", { email, password: PASSWORD });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return { browser, email, id: result.body.user.id as string };
}

async function adminBrowser() {
  const browser: Browser = { cookie: undefined };
  const result = await call(browser, "POST", "/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  assert.equal(result.status, 200);
  return browser;
}

async function auditCount(action: string, outcome: string, resourceId?: string) {
  const result = await pool!.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM audit_logs WHERE action = $1 AND outcome = $2 AND ($3::text IS NULL OR resource_id = $3)`,
    [action, outcome, resourceId ?? null],
  );
  return result.rows[0]!.n;
}

const CERT = "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-TEST";
async function deliver(event: Record<string, unknown>, rawOverride?: string) {
  const raw = rawOverride ?? JSON.stringify(event);
  const response = await fetch(`${base}/api/paypal/webhooks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-cert-url": CERT,
      "paypal-transmission-id": `tx-${randomBytes(4).toString("hex")}`,
      "paypal-transmission-sig": "c2lnbmF0dXJl",
      "paypal-transmission-time": new Date(clock).toISOString(),
    },
    body: raw,
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

let eventCounter = 0;
function subscriptionEvent(type: string, subscriptionId: string, customId?: string) {
  return {
    id: `WH-EVT-${++eventCounter}-${randomBytes(3).toString("hex")}`,
    event_type: type,
    create_time: new Date(clock).toISOString(),
    resource_type: "subscription",
    resource: { id: subscriptionId, ...(customId ? { custom_id: customId } : {}) },
  };
}

async function subscribed(browser: Browser) {
  const created = await call(browser, "POST", "/api/subscriptions", {});
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const row = await pool!.query<{ paypal_subscription_id: string; id: string }>(
    `SELECT id, paypal_subscription_id FROM subscriptions WHERE id = $1`,
    [created.body.subscription.id],
  );
  return { rowId: row.rows[0]!.id, paypalId: row.rows[0]!.paypal_subscription_id, created };
}

// ---- Schema -------------------------------------------------------------------

dbTest("migrations 3 to 5 are recorded and create every account table without touching paypal_orders", async () => {
  const versions = (await pool!.query<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version")).rows.map((row) => row.version);
  assert.deepEqual(versions, [1, 2, 3, 4, 5]);
  for (const table of ["users", "user_roles", "sessions", "audit_logs", "subscriptions", "paypal_webhook_events", "projects", "ai_usage", "paypal_orders"]) {
    const exists = await pool!.query<{ ok: boolean }>("SELECT to_regclass($1) IS NOT NULL AS ok", [table]);
    assert.ok(exists.rows[0]!.ok, table);
  }
  // Running the migrations again changes nothing.
  assert.deepEqual(await migrateAccountSchema(pool!), []);
  assert.deepEqual(ACCOUNT_MIGRATIONS.map((m) => m.version), [3, 4, 5]);
});

// ---- Authentication -----------------------------------------------------------

dbTest("registration creates a user with only the user role, an HttpOnly session cookie, and hashes only", async () => {
  const browser: Browser = { cookie: undefined };
  const email = newEmail();
  const result = await call(browser, "POST", "/api/auth/register", { email: `  ${email.toUpperCase()} `, password: PASSWORD, role: "admin", roles: ["admin"] });
  assert.equal(result.status, 201);
  assert.equal(result.body.user.email, email);
  assert.deepEqual(result.body.user.roles, ["user"], "the role in the body is ignored");
  assert.ok(!result.body.user.permissions.includes("admin:users:update"));
  assert.match(result.setCookie!, /^paypilot_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=3600$/);

  const stored = await pool!.query("SELECT password_hash FROM users WHERE email = $1", [email]);
  assert.match(stored.rows[0].password_hash, /^scrypt\$/);
  assert.ok(!JSON.stringify(stored.rows).includes(PASSWORD));
  const token = browser.cookie!.split("=")[1]!;
  const sessions = await pool!.query("SELECT token_hash FROM sessions WHERE user_id = $1", [result.body.user.id]);
  assert.equal(sessions.rowCount, 1);
  assert.notEqual(sessions.rows[0].token_hash, token, "the token itself is never stored");
  assert.equal(await auditCount("auth.register", "success", result.body.user.id), 1);

  const me = await call(browser, "GET", "/api/auth/me");
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, email);
});

dbTest("a duplicate email is refused, whatever its case", async () => {
  const { email } = await registered();
  const again = await call({ cookie: undefined }, "POST", "/api/auth/register", { email: email.toUpperCase(), password: PASSWORD });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, "EMAIL_TAKEN");
  const users = await pool!.query("SELECT COUNT(*)::int AS n FROM users WHERE email = $1", [email]);
  assert.equal(users.rows[0].n, 1);
});

dbTest("invalid passwords and emails are refused without creating an account", async () => {
  for (const [email, password, code] of [
    [newEmail(), "short", "WEAK_PASSWORD"],
    [newEmail(), "x".repeat(129), "WEAK_PASSWORD"],
    [newEmail(), "aaaaaaaaaaaaaaaa", "WEAK_PASSWORD"],
    ["not-an-email", PASSWORD, "INVALID_INPUT"],
    [newEmail(), "", "INVALID_INPUT"],
  ] as const) {
    const result = await call({ cookie: undefined }, "POST", "/api/auth/register", { email, password });
    assert.equal(result.status, 400, `${email} / ${password.length}`);
    assert.equal(result.body.code, code);
    assert.equal(result.setCookie, null);
  }
  const bodies = await call({ cookie: undefined }, "POST", "/api/auth/register", { email: { $ne: "" }, password: PASSWORD });
  assert.equal(bodies.status, 400);
});

dbTest("login succeeds with the right password and fails identically for a wrong password or unknown email", async () => {
  const { email, id } = await registered();
  const wrong = await call({ cookie: undefined }, "POST", "/api/auth/login", { email, password: "wrong-password-123" });
  const unknown = await call({ cookie: undefined }, "POST", "/api/auth/login", { email: newEmail(), password: PASSWORD });
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.body, unknown.body);
  assert.equal(wrong.setCookie, null);
  assert.equal(await auditCount("auth.login", "failure", id), 1);

  const browser: Browser = { cookie: undefined };
  const ok = await call(browser, "POST", "/api/auth/login", { email: email.toUpperCase(), password: PASSWORD });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.id, id);
  assert.equal((await call(browser, "GET", "/api/auth/me")).status, 200);
  assert.equal(await auditCount("auth.login", "success", id), 1);
});

dbTest("logging in starts a new session and revokes the one the browser presented (no session fixation)", async () => {
  const { browser, email } = await registered();
  const before = browser.cookie;
  await call(browser, "POST", "/api/auth/login", { email, password: PASSWORD });
  assert.notEqual(browser.cookie, before);
  assert.equal((await call({ cookie: before }, "GET", "/api/auth/me")).status, 401, "the old session no longer works");
  assert.equal((await call(browser, "GET", "/api/auth/me")).status, 200);
});

dbTest("repeated failed logins lock the account for a while", async () => {
  const { email } = await registered();
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal((await call(undefined, "POST", "/api/auth/login", { email, password: "wrong-password-123" })).status, 401);
  }
  const locked = await call(undefined, "POST", "/api/auth/login", { email, password: PASSWORD });
  assert.equal(locked.status, 429);
  assert.equal(locked.body.code, "LOCKED_OUT");
  clock += 16 * 60_000;
  assert.equal((await call(undefined, "POST", "/api/auth/login", { email, password: PASSWORD })).status, 200);
});

dbTest("logout revokes the session on the server and clears the cookie", async () => {
  const { browser, id } = await registered();
  const stolen = browser.cookie;
  const result = await call(browser, "POST", "/api/auth/logout", {});
  assert.equal(result.status, 200);
  assert.match(result.setCookie!, /Max-Age=0/);
  assert.equal((await call({ cookie: stolen }, "GET", "/api/auth/me")).status, 401, "a copied cookie stops working");
  const revoked = await pool!.query("SELECT revoked_at FROM sessions WHERE user_id = $1", [id]);
  assert.ok(revoked.rows[0].revoked_at);
  const logged = await pool!.query("SELECT COUNT(*)::int AS n FROM audit_logs WHERE action = 'auth.logout' AND actor_user_id = $1", [id]);
  assert.equal(logged.rows[0].n, 1);
});

dbTest("sessions expire after their lifetime", async () => {
  const { browser } = await registered();
  assert.equal((await call(browser, "GET", "/api/auth/me")).status, 200);
  clock += 61 * 60_000; // SESSION_TTL_HOURS=1 in this test app.
  const expired = await call(browser, "GET", "/api/auth/me");
  assert.equal(expired.status, 401);
  assert.equal(expired.body.code, "AUTH_REQUIRED");
});

dbTest("revoking all sessions signs the account out everywhere; an admin can do it for a user", async () => {
  const { browser, email, id } = await registered();
  const other: Browser = { cookie: undefined };
  await call(other, "POST", "/api/auth/login", { email, password: PASSWORD });
  const result = await call(browser, "POST", "/api/auth/sessions/revoke-all", {});
  assert.equal(result.body.revokedSessions, 2);
  assert.equal((await call(other, "GET", "/api/auth/me")).status, 401);
  assert.equal((await call(browser, "GET", "/api/auth/me")).status, 401);

  const again: Browser = { cookie: undefined };
  await call(again, "POST", "/api/auth/login", { email, password: PASSWORD });
  const admin = await adminBrowser();
  const byAdmin = await call(admin, "POST", `/api/admin/users/${id}/sessions/revoke`, {});
  assert.equal(byAdmin.status, 200);
  assert.equal(byAdmin.body.revokedSessions, 1);
  assert.equal((await call(again, "GET", "/api/auth/me")).status, 401);
  assert.ok((await auditCount("auth.sessions.revoke", "success", id)) >= 2);
});

dbTest("cookie-authenticated writes and account requests need an allowed Origin (CSRF)", async () => {
  const { browser } = await registered();
  const noOrigin = await call(browser, "POST", "/api/subscriptions", {}, { Origin: null });
  assert.equal(noOrigin.status, 403);
  assert.equal(noOrigin.body.code, "ORIGIN_REQUIRED");
  const foreign = await call(browser, "POST", "/api/subscriptions", {}, { Origin: "https://evil.example" });
  assert.equal(foreign.status, 403);
  const loginCsrf = await call(undefined, "POST", "/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }, { Origin: null });
  assert.equal(loginCsrf.status, 403);
  const form = await call(browser, "POST", "/api/auth/logout", "a=1", { "Content-Type": "application/x-www-form-urlencoded" });
  assert.equal(form.status, 415);
  assert.equal((await call(browser, "GET", "/api/auth/me")).status, 200, "none of these signed the user out");
});

// ---- RBAC ---------------------------------------------------------------------

dbTest("unauthenticated requests are rejected on every protected route", async () => {
  for (const [method, path] of [
    ["GET", "/api/auth/me"],
    ["GET", "/api/admin/users"],
    ["GET", "/api/admin/audit-logs"],
    ["GET", "/api/subscriptions/current"],
    ["POST", "/api/subscriptions"],
    ["POST", "/api/subscriptions/sync"],
    ["POST", "/api/subscriptions/cancel"],
    ["POST", "/api/proposals/analyze"],
  ] as const) {
    const result = await call(undefined, method, path, method === "POST" ? {} : undefined);
    assert.equal(result.status, 401, `${method} ${path}`);
    assert.equal(result.body.code, "AUTH_REQUIRED");
  }
  const forged = await call({ cookie: `paypilot_session=${"A".repeat(43)}` }, "GET", "/api/auth/me");
  assert.equal(forged.status, 401);
});

dbTest("a user cannot use admin endpoints, and each refusal is audited", async () => {
  const { browser, id } = await registered();
  const { id: otherId } = await registered();
  for (const [method, path] of [
    ["GET", "/api/admin/users"],
    ["GET", "/api/admin/audit-logs"],
    ["POST", `/api/admin/users/${otherId}/role`],
    ["POST", `/api/admin/users/${otherId}/sessions/revoke`],
  ] as const) {
    const result = await call(browser, method, path, method === "POST" ? { role: "admin" } : undefined);
    assert.equal(result.status, 403, `${method} ${path}`);
    assert.equal(result.body.code, "FORBIDDEN");
  }
  const denied = await pool!.query("SELECT COUNT(*)::int AS n FROM audit_logs WHERE action = 'authz.denied' AND actor_user_id = $1", [id]);
  assert.equal(denied.rows[0].n, 4);
});

dbTest("a user cannot make themselves an admin", async () => {
  const { browser, id } = await registered();
  const self = await call(browser, "POST", `/api/admin/users/${id}/role`, { role: "admin" });
  assert.equal(self.status, 403);
  const roles = await pool!.query("SELECT role FROM user_roles WHERE user_id = $1", [id]);
  assert.deepEqual(roles.rows.map((row) => row.role), ["user"]);
  const me = await call(browser, "GET", "/api/auth/me");
  assert.deepEqual(me.body.user.roles, ["user"]);
});

dbTest("admin permissions work: list users, grant and remove a role, read the audit log; never their own role", async () => {
  const admin = await adminBrowser();
  const me = await call(admin, "GET", "/api/auth/me");
  assert.deepEqual(me.body.user.roles, ["admin", "user"]);
  const { browser, id } = await registered();

  const users = await call(admin, "GET", "/api/admin/users");
  assert.equal(users.status, 200);
  const listed = users.body.users.find((user: { id: string }) => user.id === id);
  assert.deepEqual(listed.roles, ["user"]);
  assert.ok(!JSON.stringify(users.body).includes("scrypt$"), "no password hashes are returned");

  assert.equal((await call(admin, "POST", `/api/admin/users/${id}/role`, { role: "admin" })).status, 200);
  assert.equal((await call(browser, "GET", "/api/admin/users")).status, 200, "the new role applies at once");
  assert.equal((await call(admin, "POST", `/api/admin/users/${id}/role`, { role: "user" })).status, 200);
  assert.equal((await call(browser, "GET", "/api/admin/users")).status, 403);
  assert.equal(await auditCount("admin.role.change", "success", id), 2);

  const adminId = me.body.user.id;
  const selfChange = await call(admin, "POST", `/api/admin/users/${adminId}/role`, { role: "user" });
  assert.equal(selfChange.status, 403);
  assert.equal((await call(admin, "POST", "/api/admin/users/not-a-uuid/role", { role: "admin" })).status, 400);
  assert.equal((await call(admin, "POST", `/api/admin/users/${id}/role`, { role: "owner" })).status, 400);

  const log = await call(admin, "GET", "/api/admin/audit-logs?limit=200");
  assert.equal(log.status, 200);
  const text = JSON.stringify(log.body);
  assert.ok(log.body.entries.some((entry: { action: string }) => entry.action === "admin.role.change"));
  for (const secret of [PASSWORD, ADMIN_PASSWORD, "scrypt$", "FAKE-TOKEN"]) assert.ok(!text.includes(secret), secret);
});

dbTest("the bootstrap admin is created once and never promotes an existing account", async () => {
  const count = async () => (await pool!.query("SELECT COUNT(*)::int AS n FROM user_roles WHERE role = 'admin'")).rows[0].n;
  const before = await count();
  await auth.bootstrapAdmin(ADMIN_EMAIL, ADMIN_PASSWORD);
  const { email, id } = await registered();
  await auth.bootstrapAdmin(email, "another-strong-password-9");
  assert.equal(await count(), before);
  const roles = await pool!.query("SELECT role FROM user_roles WHERE user_id = $1", [id]);
  assert.deepEqual(roles.rows.map((row) => row.role), ["user"]);
});

// ---- Subscriptions ------------------------------------------------------------

dbTest("creating a subscription records it as APPROVAL_PENDING and returns PayPal's approval link; it is not yet an entitlement", async () => {
  const { browser, id } = await registered();
  assert.equal((await call(browser, "POST", "/api/proposals/draft", {})).status, 402);
  const { created, rowId, paypalId } = await subscribed(browser);
  assert.match(created.body.approveUrl, /^https:\/\/www\.sandbox\.paypal\.com\//);
  assert.equal(created.body.subscription.status, "APPROVAL_PENDING");
  assert.equal(created.body.subscription.entitled, false);
  assert.deepEqual(created.body.offer, { price: "5.00", currency: "USD", interval: "MONTH", intervalCount: 1, trialDays: 7 });
  const request = JSON.parse(paypal.calls.filter((c) => c.path === "/v1/billing/subscriptions").at(-1)!.body!);
  assert.equal(request.plan_id, PLAN_ID);
  assert.equal(request.custom_id, rowId);
  assert.equal(request.application_context.return_url, `${ORIGIN}/?subscription=return`);
  assert.ok(paypalId.startsWith("I-"));
  const draft = await call(browser, "POST", "/api/proposals/draft", {});
  assert.equal(draft.status, 402);
  assert.equal(draft.body.code, "SUBSCRIPTION_REQUIRED");
  assert.equal(draft.body.subscriptionStatus, "APPROVAL_PENDING");
  assert.equal(await auditCount("subscription.create", "success", rowId), 1);
  const owner = await pool!.query("SELECT user_id FROM subscriptions WHERE id = $1", [rowId]);
  assert.equal(owner.rows[0].user_id, id);
});

dbTest("a plan that is not the 7-day trial plus USD 5 monthly is refused before any subscription is created", async () => {
  const original = paypal.plan;
  try {
    const module = createSubscriptionModule({
      pool: pool!,
      auth,
      payPal: { fetch: fakePayPalFetch, baseUrl: "https://api-m.sandbox.paypal.com", getAccessToken: async () => "FAKE-TOKEN" },
      planId: PLAN_ID,
      webhookId: WEBHOOK_ID,
      allowedOrigins: [ORIGIN],
      now: () => clock,
      logger: silent,
    });
    paypal.plan = { ...original, billing_cycles: [(original.billing_cycles as unknown[])[1]] }; // No trial.
    const app = express();
    app.use(express.json());
    app.use(auth.authenticate);
    app.use(module.router);
    const misconfigured = createServer(app).listen(0, "127.0.0.1");
    await once(misconfigured, "listening");
    try {
      const { browser } = await registered();
      const before = paypal.count("POST", "/v1/billing/subscriptions");
      const response = await fetch(`http://127.0.0.1:${(misconfigured.address() as AddressInfo).port}/api/subscriptions`, {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json", Cookie: browser.cookie! },
        body: "{}",
      });
      assert.equal(response.status, 503);
      assert.equal(((await response.json()) as { code: string }).code, "PLAN_MISCONFIGURED");
      assert.equal(paypal.count("POST", "/v1/billing/subscriptions"), before);
    } finally {
      await new Promise((resolve) => misconfigured.close(resolve));
    }
  } finally {
    paypal.plan = original;
  }
});

dbTest("after approval, the server confirms ACTIVE with PayPal and the paid feature unlocks (trial included)", async () => {
  const { browser } = await registered();
  const { paypalId } = await subscribed(browser);
  // The browser returning from PayPal proves nothing: still pending.
  const early = await call(browser, "POST", "/api/subscriptions/sync", { subscriptionId: paypalId });
  assert.equal(early.body.subscription.status, "APPROVAL_PENDING");
  assert.equal((await call(browser, "POST", "/api/proposals/draft", {})).status, 402);

  paypal.setStatus(paypalId, "ACTIVE");
  const synced = await call(browser, "POST", "/api/subscriptions/sync", { subscriptionId: paypalId });
  assert.equal(synced.status, 200);
  assert.equal(synced.body.subscription.status, "ACTIVE");
  assert.equal(synced.body.subscription.entitled, true);
  assert.equal(synced.body.subscription.nextBillingTime, "2026-11-18T10:00:00.000Z");
  const draft = await call(browser, "POST", "/api/proposals/draft", {});
  assert.equal(draft.status, 200);
  assert.equal(draft.body.proposal, "ran");
  assert.equal((await call(browser, "POST", "/api/subscriptions", {})).status, 409, "no second subscription");
});

for (const [eventType, status] of [
  ["BILLING.SUBSCRIPTION.SUSPENDED", "SUSPENDED"],
  ["BILLING.SUBSCRIPTION.CANCELLED", "CANCELLED"],
  ["BILLING.SUBSCRIPTION.EXPIRED", "EXPIRED"],
] as const) {
  dbTest(`a verified ${eventType} webhook ends the entitlement`, async () => {
    const { browser } = await registered();
    const { paypalId, rowId } = await subscribed(browser);
    paypal.setStatus(paypalId, "ACTIVE");
    assert.equal((await deliver(subscriptionEvent("BILLING.SUBSCRIPTION.ACTIVATED", paypalId, rowId))).status, 200);
    assert.equal((await call(browser, "POST", "/api/proposals/draft", {})).status, 200);

    paypal.setStatus(paypalId, status);
    const delivered = await deliver(subscriptionEvent(eventType, paypalId, rowId));
    assert.equal(delivered.status, 200);
    const draft = await call(browser, "POST", "/api/proposals/draft", {});
    assert.equal(draft.status, 402);
    assert.equal(draft.body.subscriptionStatus, status);
    const current = await call(browser, "GET", "/api/subscriptions/current");
    assert.equal(current.body.subscription.status, status);
    assert.equal(current.body.subscription.entitled, false);
    assert.ok((await auditCount("subscription.status.change", "success", rowId)) >= 2);
  });
}

dbTest("a subscriber can cancel; PayPal is asked to cancel and the entitlement ends", async () => {
  const { browser } = await registered();
  const { paypalId } = await subscribed(browser);
  paypal.setStatus(paypalId, "ACTIVE");
  await call(browser, "POST", "/api/subscriptions/sync", { subscriptionId: paypalId });
  const cancelled = await call(browser, "POST", "/api/subscriptions/cancel", {});
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.subscription.status, "CANCELLED");
  assert.equal(paypal.subscriptions.get(paypalId)!.status, "CANCELLED");
  assert.equal((await call(browser, "POST", "/api/proposals/draft", {})).status, 402);
});

dbTest("webhooks with an invalid signature, missing headers or a forged certificate URL change nothing", async () => {
  const { browser } = await registered();
  const { paypalId, rowId } = await subscribed(browser);
  paypal.setStatus(paypalId, "ACTIVE");
  paypal.verification = "FAILURE";
  try {
    const forged = await deliver(subscriptionEvent("BILLING.SUBSCRIPTION.ACTIVATED", paypalId, rowId));
    assert.equal(forged.status, 400);
  } finally {
    paypal.verification = "SUCCESS";
  }
  const noHeaders = await fetch(`${base}/api/paypal/webhooks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(subscriptionEvent("BILLING.SUBSCRIPTION.ACTIVATED", paypalId, rowId)),
  });
  assert.equal(noHeaders.status, 400);
  const status = await pool!.query("SELECT status FROM subscriptions WHERE id = $1", [rowId]);
  assert.equal(status.rows[0].status, "APPROVAL_PENDING", "nothing was applied");
  assert.equal((await call(browser, "POST", "/api/proposals/draft", {})).status, 402);
  assert.ok((await auditCount("webhook.process", "failure")) >= 2);
  const events = await pool!.query("SELECT COUNT(*)::int AS n FROM paypal_webhook_events WHERE resource_id = $1", [paypalId]);
  assert.equal(events.rows[0].n, 0, "unverified deliveries are not recorded as events");
});

dbTest("the webhook body is verified byte for byte as PayPal sent it", async () => {
  const { browser } = await registered();
  const { paypalId, rowId } = await subscribed(browser);
  const event = subscriptionEvent("BILLING.SUBSCRIPTION.ACTIVATED", paypalId, rowId);
  // Unusual spacing and key order, as a real delivery may have.
  const raw = `{ "resource":{"custom_id":"${rowId}","id":"${paypalId}"},"id":"${event.id}","event_type":"${event.event_type}" ,"create_time":"${event.create_time}" }`;
  paypal.setStatus(paypalId, "ACTIVE");
  assert.equal((await deliver(event, raw)).status, 200);
  const verifyCall = paypal.calls.filter((c) => c.path === "/v1/notifications/verify-webhook-signature").at(-1)!;
  assert.ok(verifyCall.body!.endsWith(`"webhook_event":${raw}}`));
  assert.equal(JSON.parse(verifyCall.body!).webhook_id, WEBHOOK_ID);
});

dbTest("a redelivered webhook event is processed only once", async () => {
  const { browser } = await registered();
  const { paypalId, rowId } = await subscribed(browser);
  paypal.setStatus(paypalId, "ACTIVE");
  const event = subscriptionEvent("BILLING.SUBSCRIPTION.ACTIVATED", paypalId, rowId);
  const lookups = () => paypal.count("GET", `/v1/billing/subscriptions/${paypalId}`);
  const first = await deliver(event);
  const afterFirst = lookups();
  const second = await deliver(event);
  const third = await deliver(event);
  assert.equal(first.status, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(third.body.duplicate, true);
  assert.equal(lookups(), afterFirst, "duplicates never reach PayPal or the subscription");
  const row = await pool!.query("SELECT status, attempts FROM paypal_webhook_events WHERE event_id = $1", [event.id]);
  assert.deepEqual(row.rows[0], { status: "PROCESSED", attempts: 1 });
});

dbTest("events delivered out of order cannot move a subscription back to an older state", async () => {
  const { browser } = await registered();
  const { paypalId, rowId } = await subscribed(browser);
  paypal.setStatus(paypalId, "ACTIVE");
  const activated = subscriptionEvent("BILLING.SUBSCRIPTION.ACTIVATED", paypalId, rowId);
  paypal.setStatus(paypalId, "CANCELLED");
  const cancelled = subscriptionEvent("BILLING.SUBSCRIPTION.CANCELLED", paypalId, rowId);
  // The cancellation arrives first, the older activation afterwards.
  assert.equal((await deliver(cancelled)).status, 200);
  assert.equal((await deliver(activated)).status, 200);
  const current = await call(browser, "GET", "/api/subscriptions/current");
  assert.equal(current.body.subscription.status, "CANCELLED");
  assert.equal((await call(browser, "POST", "/api/proposals/draft", {})).status, 402);

  // A stale snapshot (older status_update_time) never replaces a newer one,
  // and a CANCELLED subscription is never reopened.
  const kept = await subscriptions.applySnapshot(
    rowId,
    { id: paypalId, status: "ACTIVE", planId: PLAN_ID, customId: rowId, statusUpdateTime: new Date("2026-01-01T00:00:00Z"), nextBillingTime: undefined },
    "webhook",
  );
  assert.equal(kept!.status, "CANCELLED");
  const reopened = await subscriptions.applySnapshot(
    rowId,
    { id: paypalId, status: "ACTIVE", planId: PLAN_ID, customId: rowId, statusUpdateTime: new Date("2030-01-01T00:00:00Z"), nextBillingTime: undefined },
    "webhook",
  );
  assert.equal(reopened!.status, "CANCELLED");
});

dbTest("ownership: a user can't read or sync another user's subscription, and PayPal data for another record is refused", async () => {
  const alice = await registered();
  const bob = await registered();
  const { paypalId, rowId } = await subscribed(alice.browser);
  paypal.setStatus(paypalId, "ACTIVE");
  const bobSync = await call(bob.browser, "POST", "/api/subscriptions/sync", { subscriptionId: paypalId });
  assert.equal(bobSync.status, 404);
  const bobCurrent = await call(bob.browser, "GET", "/api/subscriptions/current");
  assert.equal(bobCurrent.body.subscription, null);
  assert.equal((await call(bob.browser, "POST", "/api/proposals/draft", {})).status, 402, "Alice's subscription entitles only Alice");
  assert.equal((await call(bob.browser, "POST", "/api/subscriptions/cancel", {})).status, 404);
  assert.equal(paypal.subscriptions.get(paypalId)!.status, "ACTIVE", "Bob could not cancel it");

  // PayPal reporting a different custom_id (another record's id) is refused.
  paypal.subscriptions.get(paypalId)!.custom_id = "00000000-0000-4000-8000-000000000000";
  const mismatched = await deliver(subscriptionEvent("BILLING.SUBSCRIPTION.ACTIVATED", paypalId, rowId));
  assert.equal(mismatched.status, 200);
  assert.equal(mismatched.body.ignored, true);
  const status = await pool!.query("SELECT status FROM subscriptions WHERE id = $1", [rowId]);
  assert.equal(status.rows[0].status, "APPROVAL_PENDING");
  assert.equal((await call(bob.browser, "POST", "/api/subscriptions/sync", { subscriptionId: "not-an-id" })).status, 400);
});

dbTest("non-subscription and unknown-subscription events are acknowledged and ignored", async () => {
  const sale = await deliver({ id: `WH-SALE-${randomBytes(3).toString("hex")}`, event_type: "PAYMENT.SALE.COMPLETED", resource: { id: "SALE-1" } });
  assert.equal(sale.status, 200);
  assert.equal(sale.body.ignored, true);
  const unknown = await deliver(subscriptionEvent("BILLING.SUBSCRIPTION.ACTIVATED", "I-UNKNOWNSUB999"));
  assert.equal(unknown.body.ignored, true);
});

// ---- AI routes: authentication vs authorization vs subscription ---------------

const AI_ROUTES = ["/api/proposals/analyze", "/api/proposals/draft", "/api/proposals/review"] as const;

dbTest("AI routes: a missing, malformed, unknown, revoked or expired session is 401 AUTH_REQUIRED on every route", async () => {
  const { browser, email } = await registered();
  const revoked: Browser = { cookie: browser.cookie };
  await call(browser, "POST", "/api/auth/login", { email, password: PASSWORD }); // Revokes the first session.
  const expiring = await registered();
  const cases: Array<[string, Browser | undefined, () => void]> = [
    ["no cookie", undefined, () => {}],
    ["malformed cookie", { cookie: "paypilot_session=not-a-token" }, () => {}],
    ["unknown token", { cookie: `paypilot_session=${randomBytes(32).toString("base64url")}` }, () => {}],
    ["cookie with another name", { cookie: `other=${browser.cookie!.split("=")[1]}` }, () => {}],
    ["revoked session", revoked, () => {}],
    ["expired session", expiring.browser, () => { clock += 61 * 60_000; }],
  ];
  for (const [label, who, prepare] of cases) {
    prepare();
    for (const route of AI_ROUTES) {
      const result = await call(who, "POST", route, {});
      assert.equal(result.status, 401, `${label} ${route}`);
      assert.equal(result.body.code, "AUTH_REQUIRED", `${label} ${route}`);
    }
  }
});

dbTest("AI routes: a signed-in user without a subscription is 402 SUBSCRIPTION_REQUIRED on the Pro routes, never an authentication error", async () => {
  const { browser } = await registered();
  for (const route of ["/api/proposals/draft", "/api/proposals/review"]) {
    const result = await call(browser, "POST", route, {});
    assert.equal(result.status, 402, route);
    assert.equal(result.body.code, "SUBSCRIPTION_REQUIRED", route);
    assert.equal(result.body.subscriptionStatus, null, route);
  }
  // Brief analysis is on the Free plan, within its monthly allowance.
  assert.equal((await call(browser, "POST", "/api/proposals/analyze", {})).status, 200);
  assert.equal((await call(browser, "GET", "/api/auth/me")).status, 200, "the session is still valid");
});

dbTest("AI routes: a signed-in user without the permission is 403 FORBIDDEN, before the subscription check", async () => {
  const { browser, id } = await registered();
  const { paypalId } = await subscribed(browser);
  paypal.setStatus(paypalId, "ACTIVE");
  await call(browser, "POST", "/api/subscriptions/sync", { subscriptionId: paypalId });
  await pool!.query("DELETE FROM user_roles WHERE user_id = $1", [id]); // No role, no permissions.
  for (const route of AI_ROUTES) {
    const result = await call(browser, "POST", route, {});
    assert.equal(result.status, 403, route);
    assert.equal(result.body.code, "FORBIDDEN", route);
  }
});

dbTest("AI routes: a signed-in user with an active subscription reaches every AI handler", async () => {
  const { browser } = await registered();
  const { paypalId } = await subscribed(browser);
  paypal.setStatus(paypalId, "ACTIVE");
  await call(browser, "POST", "/api/subscriptions/sync", { subscriptionId: paypalId });
  assert.equal((await call(browser, "POST", "/api/proposals/analyze", {})).body.analysis, "ran");
  assert.equal((await call(browser, "POST", "/api/proposals/draft", {})).body.proposal, "ran");
  assert.deepEqual((await call(browser, "POST", "/api/proposals/review", {})).body.findings, []);
});

// ---- Projects -------------------------------------------------------------------

const BRIEF = "A client wants a five-page business website with a contact form, delivery in two weeks, and a budget of $800.";
const PROPOSAL_DOC = { title: "Business website", summary: "Five pages.", sections: [], budgetItems: [], payments: [], generationNotes: [], sourceBrief: BRIEF };
const REVIEW_DOC = { fingerprint: "fp-1", findings: [{ id: "f1", severity: "High", title: "Deadline risk" }], ranAt: "2026-11-11T10:00:00.000Z" };

async function proUser() {
  const user = await registered();
  const { paypalId } = await subscribed(user.browser);
  paypal.setStatus(paypalId, "ACTIVE");
  await call(user.browser, "POST", "/api/subscriptions/sync", { subscriptionId: paypalId });
  return { ...user, paypalId };
}

async function newProject(browser: Browser, fields: Record<string, unknown> = {}) {
  const result = await call(browser, "POST", "/api/projects", { name: "Acme website", clientName: "Acme Ltd", brief: BRIEF, ...fields });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.project as Record<string, any>;
}

async function usageOf(browser: Browser) {
  return (await call(browser, "GET", "/api/usage")).body as Record<string, any>;
}

// The refund for a failed analysis runs when the response finishes.
async function waitForUsage(browser: Browser, used: number) {
  for (let i = 0; i < 40; i++) {
    if ((await usageOf(browser)).analyses.used === used) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal((await usageOf(browser)).analyses.used, used);
}

dbTest("projects: create, list with dashboard stats, and reopen with every field as entered", async () => {
  const { browser } = await registered();
  const project = await newProject(browser, { estimatedBudget: 800, budgetCurrency: "USD", deadline: "2026-11-25" });
  assert.equal(project.status, "LEAD");
  assert.equal(project.proposalStatus, null);
  assert.equal(project.estimatedBudget, "800.00");
  assert.equal(project.deadline, "2026-11-25", "no time-zone shift");
  await newProject(browser, { name: "Second", status: "ACTIVE" });
  await newProject(browser, { name: "Done", status: "COMPLETED" });

  const list = await call(browser, "GET", "/api/projects");
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.stats, { total: 3, active: 1, pendingProposals: 0, completed: 1 });
  assert.equal(list.body.projects[0].name, "Done", "most recently updated first");
  assert.ok(!("brief" in list.body.projects[0]), "the list carries summaries only");

  const reopened = await call(browser, "GET", `/api/projects/${project.id}`);
  assert.equal(reopened.status, 200);
  assert.equal(reopened.body.project.brief, BRIEF);
  assert.equal(reopened.body.project.clientName, "Acme Ltd");
  assert.equal(reopened.body.project.analysis, null);
});

dbTest("projects: saved work persists across sign-out and a new session", async () => {
  const { browser, email } = await registered();
  const project = await newProject(browser);
  await call(browser, "PUT", `/api/projects/${project.id}/analysis`, { analysis: { deliverables: ["Website"], timeline: "two weeks" } });
  await call(browser, "POST", "/api/auth/logout", {});
  const again: Browser = { cookie: undefined };
  await call(again, "POST", "/api/auth/login", { email, password: PASSWORD });
  const reopened = await call(again, "GET", `/api/projects/${project.id}`);
  assert.equal(reopened.status, 200);
  assert.deepEqual(reopened.body.project.analysis, { deliverables: ["Website"], timeline: "two weeks" });
  assert.equal(reopened.body.project.hasAnalysis, true);
});

dbTest("projects: a user can never see, change or save into another user's project", async () => {
  const alice = await proUser();
  const bob = await proUser();
  const project = await newProject(alice.browser);
  for (const [method, path, body] of [
    ["GET", `/api/projects/${project.id}`, undefined],
    ["PATCH", `/api/projects/${project.id}`, { name: "Stolen" }],
    ["PUT", `/api/projects/${project.id}/analysis`, { analysis: { x: 1 } }],
    ["PUT", `/api/projects/${project.id}/proposal`, { proposal: PROPOSAL_DOC }],
    ["PUT", `/api/projects/${project.id}/risk-review`, { review: REVIEW_DOC }],
  ] as const) {
    const result = await call(bob.browser, method, path, body);
    assert.equal(result.status, 404, `${method} ${path}`);
  }
  assert.equal((await call(bob.browser, "GET", "/api/projects")).body.stats.total, 0);
  assert.equal((await call(bob.browser, "GET", "/api/projects/not-a-uuid")).status, 404);
  const untouched = await call(alice.browser, "GET", `/api/projects/${project.id}`);
  assert.equal(untouched.body.project.name, "Acme website");
  assert.equal(untouched.body.project.proposal, null);
});

dbTest("projects: every route needs a session and an allowed Origin", async () => {
  const { browser } = await registered();
  const project = await newProject(browser);
  for (const [method, path] of [["GET", "/api/projects"], ["POST", "/api/projects"], ["GET", `/api/projects/${project.id}`], ["PATCH", `/api/projects/${project.id}`]] as const) {
    assert.equal((await call(undefined, method, path, method === "GET" ? undefined : { name: "x" })).status, 401, `${method} ${path}`);
  }
  assert.equal((await call(browser, "POST", "/api/projects", { name: "x" }, { Origin: null })).status, 403);
});

dbTest("projects: updates are validated, statuses are restricted, and values are stored literally", async () => {
  const { browser } = await registered();
  const project = await newProject(browser);
  const injected = "Robert'); DROP TABLE projects;--";
  const renamed = await call(browser, "PATCH", `/api/projects/${project.id}`, { name: injected, status: "ACTIVE", deadline: null });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.project.name, injected);
  assert.equal(renamed.body.project.status, "ACTIVE");
  for (const body of [{ status: "WON" }, { name: "" }, { deadline: "next week" }, { budgetCurrency: "usd" }, { estimatedBudget: -5 }, {}]) {
    assert.equal((await call(browser, "PATCH", `/api/projects/${project.id}`, body)).status, 400, JSON.stringify(body));
  }
  const noProposal = await call(browser, "PATCH", `/api/projects/${project.id}`, { proposalStatus: "SENT" });
  assert.equal(noProposal.status, 409);
  assert.equal(noProposal.body.code, "NO_PROPOSAL");
  assert.equal((await call(browser, "GET", "/api/projects")).body.stats.total, 1, "the table is intact");
});

dbTest("proposals: Pro users save, edit and track a proposal through Draft, Sent and Accepted", async () => {
  const { browser } = await proUser();
  const project = await newProject(browser);
  const saved = await call(browser, "PUT", `/api/projects/${project.id}/proposal`, { proposal: PROPOSAL_DOC });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.project.proposalStatus, "DRAFT");
  assert.equal(saved.body.project.proposal.sourceBrief, BRIEF, "the proposal keeps the brief it was drafted from");

  assert.equal((await call(browser, "PATCH", `/api/projects/${project.id}`, { proposalStatus: "SENT" })).body.project.proposalStatus, "SENT");
  const edited = await call(browser, "PUT", `/api/projects/${project.id}/proposal`, { proposal: { ...PROPOSAL_DOC, title: "Business website v2" } });
  assert.equal(edited.body.project.proposal.title, "Business website v2");
  assert.equal(edited.body.project.proposalStatus, "SENT", "editing keeps the status");
  assert.equal((await call(browser, "GET", "/api/projects")).body.stats.pendingProposals, 1);
  const accepted = await call(browser, "PATCH", `/api/projects/${project.id}`, { proposalStatus: "ACCEPTED", status: "ACTIVE" });
  assert.equal(accepted.body.project.proposalStatus, "ACCEPTED");
  assert.deepEqual((await call(browser, "GET", "/api/projects")).body.stats, { total: 1, active: 1, pendingProposals: 0, completed: 0 });
  assert.equal((await call(browser, "PUT", `/api/projects/${project.id}/proposal`, { proposal: "not an object" })).status, 400);
  const huge = { ...PROPOSAL_DOC, summary: "x".repeat(85_000) };
  assert.equal((await call(browser, "PUT", `/api/projects/${project.id}/proposal`, { proposal: huge })).status, 413);
});

dbTest("risk reviews: Pro users save a review and get it back when the project is reopened", async () => {
  const { browser } = await proUser();
  const project = await newProject(browser);
  await call(browser, "PUT", `/api/projects/${project.id}/proposal`, { proposal: PROPOSAL_DOC });
  const saved = await call(browser, "PUT", `/api/projects/${project.id}/risk-review`, { review: REVIEW_DOC });
  assert.equal(saved.status, 200);
  const reopened = await call(browser, "GET", `/api/projects/${project.id}`);
  assert.deepEqual(reopened.body.project.riskReview, REVIEW_DOC);
  assert.equal(reopened.body.project.hasRiskReview, true);
  assert.equal((await call(browser, "PUT", `/api/projects/${project.id}/risk-review`, { review: { findings: [] } })).status, 400);
});

dbTest("Free plan: projects work, but saving proposals and reviews needs Pro", async () => {
  const { browser } = await registered();
  const project = await newProject(browser);
  assert.equal((await call(browser, "PUT", `/api/projects/${project.id}/analysis`, { analysis: { deliverables: [] } })).status, 200);
  for (const [path, body] of [[`/api/projects/${project.id}/proposal`, { proposal: PROPOSAL_DOC }], [`/api/projects/${project.id}/risk-review`, { review: REVIEW_DOC }]] as const) {
    const result = await call(browser, "PUT", path, body);
    assert.equal(result.status, 402, path);
    assert.equal(result.body.code, "SUBSCRIPTION_REQUIRED");
  }
  assert.equal((await call(browser, "GET", `/api/projects/${project.id}`)).body.project.proposal, null);
});

// ---- Usage and plans ------------------------------------------------------------

dbTest("usage: the Free plan allows 2 analyses a month and then refuses with USAGE_LIMIT_REACHED", async () => {
  const { browser } = await registered();
  const before = await usageOf(browser);
  assert.equal(before.plan, "FREE");
  assert.deepEqual(before.analyses, { used: 0, limit: 2, remaining: 2 });
  assert.deepEqual(before.features, { proposalGeneration: false, riskReview: false, savedProposals: false });
  assert.equal((await call(browser, "POST", "/api/proposals/analyze", {})).status, 200);
  assert.equal((await call(browser, "POST", "/api/proposals/analyze", {})).status, 200);
  const third = await call(browser, "POST", "/api/proposals/analyze", {});
  assert.equal(third.status, 402);
  assert.equal(third.body.code, "USAGE_LIMIT_REACHED");
  assert.equal(third.body.plan, "FREE");
  assert.equal(third.body.limit, 2);
  assert.deepEqual((await usageOf(browser)).analyses, { used: 2, limit: 2, remaining: 0 });
});

dbTest("usage: concurrent analyses can't exceed the limit", async () => {
  const { browser } = await registered();
  const results = await Promise.all(Array.from({ length: 10 }, () => call(browser, "POST", "/api/proposals/analyze", {})));
  assert.equal(results.filter((r) => r.status === 200).length, 2);
  assert.equal(results.filter((r) => r.status === 402).length, 8);
  assert.equal((await usageOf(browser)).analyses.used, 2);
});

dbTest("usage: a failed analysis is given back; the usage row is stored per month in PostgreSQL", async () => {
  const { browser, id } = await registered();
  assert.equal((await call(browser, "POST", "/api/proposals/analyze", { fail: true })).status, 502);
  await waitForUsage(browser, 0);
  assert.equal((await call(browser, "POST", "/api/proposals/analyze", {})).status, 200);
  const rows = await pool!.query("SELECT to_char(period_start, 'YYYY-MM-DD') AS period, feature, used FROM ai_usage WHERE user_id = $1", [id]);
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].feature, "analysis");
  assert.equal(rows.rows[0].used, 1);
  assert.match(rows.rows[0].period, /^\d{4}-\d{2}-01$/);
});

dbTest("usage: Pro gets 30 analyses a month and every Pro feature", async () => {
  const { browser, id } = await proUser();
  const usage = await usageOf(browser);
  assert.equal(usage.plan, "PRO");
  assert.deepEqual(usage.analyses, { used: 0, limit: 30, remaining: 30 });
  assert.deepEqual(usage.features, { proposalGeneration: true, riskReview: true, savedProposals: true });
  for (let i = 0; i < 3; i++) assert.equal((await call(browser, "POST", "/api/proposals/analyze", {})).status, 200, "beyond the Free limit");
  await pool!.query("UPDATE ai_usage SET used = 29 WHERE user_id = $1", [id]);
  assert.equal((await call(browser, "POST", "/api/proposals/analyze", {})).status, 200);
  const over = await call(browser, "POST", "/api/proposals/analyze", {});
  assert.equal(over.status, 429);
  assert.equal(over.body.code, "USAGE_LIMIT_REACHED");
  assert.equal(over.body.plan, "PRO");
  assert.equal(over.body.limit, 30);
});

dbTest("usage: cancelling the subscription returns the user to Free limits and Free features", async () => {
  const { browser, id } = await proUser();
  const project = await newProject(browser);
  await call(browser, "PUT", `/api/projects/${project.id}/proposal`, { proposal: PROPOSAL_DOC });
  for (let i = 0; i < 3; i++) assert.equal((await call(browser, "POST", "/api/proposals/analyze", {})).status, 200);
  assert.equal((await call(browser, "POST", "/api/subscriptions/cancel", {})).body.subscription.status, "CANCELLED");

  const usage = await usageOf(browser);
  assert.equal(usage.plan, "FREE");
  assert.deepEqual(usage.analyses, { used: 3, limit: 2, remaining: 0 });
  assert.equal((await call(browser, "POST", "/api/proposals/analyze", {})).status, 402, "3 used is over the Free limit");
  assert.equal((await call(browser, "PUT", `/api/projects/${project.id}/proposal`, { proposal: PROPOSAL_DOC })).status, 402);
  const history = await call(browser, "GET", `/api/projects/${project.id}`);
  assert.equal(history.status, 200, "saved work stays readable");
  assert.equal(history.body.project.proposal.title, "Business website");
  const used = await pool!.query("SELECT used FROM ai_usage WHERE user_id = $1", [id]);
  assert.equal(used.rows[0].used, 3);
});

dbTest("usage: the allowance starts again next month", async () => {
  const { browser, email } = await registered();
  await call(browser, "POST", "/api/proposals/analyze", {});
  await call(browser, "POST", "/api/proposals/analyze", {});
  assert.equal((await call(browser, "POST", "/api/proposals/analyze", {})).status, 402);
  clock += 32 * 24 * 3_600_000; // Into the next calendar month (sessions expire too).
  const next: Browser = { cookie: undefined };
  assert.equal((await call(next, "POST", "/api/auth/login", { email, password: PASSWORD })).status, 200);
  assert.deepEqual((await usageOf(next)).analyses, { used: 0, limit: 2, remaining: 2 });
  assert.equal((await call(next, "POST", "/api/proposals/analyze", {})).status, 200);
});
