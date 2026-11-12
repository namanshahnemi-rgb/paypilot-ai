// Tests for the account helpers: PayPal subscription return parsing, status
// wording, and the messages for refused AI requests. The browser never
// decides access; these only describe what the server reported.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_OFFER,
  accessProblem,
  canStartSubscription,
  describeOffer,
  describeSubscription,
  readSubscriptionReturn,
  type Subscription,
} from "./account.ts";

const subscription = (status: Subscription["status"]): Subscription => ({
  id: "row",
  status,
  entitled: status === "ACTIVE",
  nextBillingTime: null,
  lastVerifiedAt: null,
});

test("the PayPal subscription return is read, but only a well-formed id is kept", () => {
  assert.deepEqual(readSubscriptionReturn("?subscription=return&subscription_id=I-BW452GLLEP1G&ba_token=BA-1&token=X"), {
    kind: "returned",
    subscriptionId: "I-BW452GLLEP1G",
  });
  assert.deepEqual(readSubscriptionReturn("?subscription=return&subscription_id=<script>"), { kind: "returned", subscriptionId: null });
  assert.deepEqual(readSubscriptionReturn("?subscription=cancel"), { kind: "cancelled" });
  assert.deepEqual(readSubscriptionReturn("?payment=return&token=ABC"), { kind: "none" });
  assert.deepEqual(readSubscriptionReturn(""), { kind: "none" });
});

test("the offer is described as a 7-day free trial, then USD 5.00 per month", () => {
  assert.equal(describeOffer(DEFAULT_OFFER), "7-day free trial, then USD 5.00 per month (PayPal Sandbox)");
});

test("every subscription status has a description, and only ended or abandoned ones can be restarted", () => {
  assert.equal(describeSubscription(null), "No subscription");
  for (const status of ["APPROVAL_PENDING", "APPROVED", "ACTIVE", "SUSPENDED", "CANCELLED", "EXPIRED"] as const) {
    assert.ok(describeSubscription(subscription(status)).length > 0, status);
  }
  assert.equal(canStartSubscription(null), true);
  assert.equal(canStartSubscription(subscription("CANCELLED")), true);
  assert.equal(canStartSubscription(subscription("EXPIRED")), true);
  assert.equal(canStartSubscription(subscription("APPROVAL_PENDING")), true);
  assert.equal(canStartSubscription(subscription("ACTIVE")), false);
  assert.equal(canStartSubscription(subscription("SUSPENDED")), false);
});

test("refused AI requests get access-denied and expired-subscription messages", () => {
  assert.match(accessProblem(401, { code: "AUTH_REQUIRED" })!, /Sign in/);
  assert.match(accessProblem(402, { code: "SUBSCRIPTION_REQUIRED", subscriptionStatus: "EXPIRED" })!, /ended/);
  assert.match(accessProblem(402, { code: "SUBSCRIPTION_REQUIRED", subscriptionStatus: "CANCELLED" })!, /ended/);
  assert.match(accessProblem(402, { code: "SUBSCRIPTION_REQUIRED", subscriptionStatus: "SUSPENDED" })!, /suspended/);
  assert.match(accessProblem(402, { code: "SUBSCRIPTION_REQUIRED", subscriptionStatus: "APPROVAL_PENDING" })!, /not active yet/);
  assert.match(accessProblem(402, { code: "SUBSCRIPTION_REQUIRED", subscriptionStatus: null })!, /free trial/);
  assert.match(accessProblem(403, { code: "FORBIDDEN" })!, /does not have access/);
  assert.equal(accessProblem(502, { error: "The AI service could not draft the proposal." }), undefined);
  assert.equal(accessProblem(400, {}), undefined);
});

// ---- Sign-in must be confirmed by the server -------------------------------

import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
import { SessionNotKeptError, signInAndConfirm } from "./account.ts";

const USER = { id: "u-1", email: "a@paypilot.test", roles: ["user"], permissions: ["proposal:create"] };

// A stand-in API. `keepsSession` says whether the "browser" sent the cookie
// back: false behaves like a browser that refused the Set-Cookie (for
// example a SameSite=Lax cookie inside another site's frame).
async function fakeApi(t: TestContext, keepsSession: boolean) {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/auth/register" || req.url === "/api/auth/login") {
      res.statusCode = req.url.endsWith("register") ? 201 : 200;
      res.setHeader("Set-Cookie", "paypilot_session=x; Path=/; HttpOnly; SameSite=Lax");
      res.end(JSON.stringify({ user: USER }));
    } else if (req.url === "/api/auth/me") {
      res.statusCode = keepsSession ? 200 : 401;
      res.end(JSON.stringify(keepsSession ? { user: USER } : { error: "Sign in to continue.", code: "AUTH_REQUIRED" }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

test("registration counts as signed in only after the server recognises the session", async (t) => {
  const api = await fakeApi(t, true);
  const user = await signInAndConfirm(api.url, "register", USER.email, "purple-tractor-41-river");
  assert.equal(user.id, USER.id);
  assert.deepEqual(api.seen, ["POST /api/auth/register", "GET /api/auth/me"]);
});

for (const mode of ["register", "login"] as const) {
  test(`a ${mode} whose cookie the browser did not keep is reported, not shown as signed in`, async (t) => {
    const api = await fakeApi(t, false);
    await assert.rejects(signInAndConfirm(api.url, mode, USER.email, "purple-tractor-41-river"), (error: Error) => {
      assert.ok(error instanceof SessionNotKeptError);
      assert.equal(error.mode, mode);
      assert.match(error.message, /did not keep the sign-in cookie, so you are not signed in/);
      assert.match(error.message, /normal browser tab/);
      assert.doesNotMatch(error.message, /subscription/i, "a lost session is not a subscription problem");
      return true;
    });
  });
}

test("unauthenticated, unauthorized, subscription-required and unavailable responses get different messages", () => {
  const messages = new Set([
    accessProblem(401, { code: "AUTH_REQUIRED" }),
    accessProblem(403, { code: "FORBIDDEN" }),
    accessProblem(403, { code: "ORIGIN_REQUIRED" }),
    accessProblem(402, { code: "SUBSCRIPTION_REQUIRED", subscriptionStatus: null }),
    accessProblem(503, { code: "AUTH_UNAVAILABLE" }),
  ]);
  assert.equal(messages.size, 5);
  assert.ok(![...messages].includes(undefined));
  // A missing subscription is never reported as a sign-in problem, and vice versa.
  assert.doesNotMatch(accessProblem(402, { code: "SUBSCRIPTION_REQUIRED", subscriptionStatus: null })!, /sign in/i);
  assert.doesNotMatch(accessProblem(401, { code: "AUTH_REQUIRED" })!, /subscri/i);
});
