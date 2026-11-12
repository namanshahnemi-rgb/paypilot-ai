// Account and subscription helpers for the frontend. The browser never
// decides who is signed in or subscribed: it only displays what the backend
// reports. The session lives in an HttpOnly cookie that scripts can't read;
// requestJson sends it with every API call (credentials: "include").
import { requestJson } from "./api.ts";

export type User = {
  id: string;
  email: string;
  roles: string[];
  permissions: string[];
};

export type SubscriptionStatus =
  | "APPROVAL_PENDING"
  | "APPROVED"
  | "ACTIVE"
  | "SUSPENDED"
  | "CANCELLED"
  | "EXPIRED";

export type Subscription = {
  id: string;
  status: SubscriptionStatus;
  entitled: boolean;
  nextBillingTime: string | null;
  lastVerifiedAt: string | null;
};

export type SubscriptionOffer = {
  price: string;
  currency: string;
  interval: string;
  intervalCount: number;
  trialDays: number;
};

export type SubscriptionState = {
  subscription: Subscription | null;
  offer: SubscriptionOffer;
};

type ApiError = { error?: string; code?: string; subscriptionStatus?: SubscriptionStatus | null };

export const DEFAULT_OFFER: SubscriptionOffer = {
  price: "5.00",
  currency: "USD",
  interval: "MONTH",
  intervalCount: 1,
  trialDays: 7,
};

const PAYPAL_SUBSCRIPTION_ID = /^I-[A-Z0-9]{6,40}$/;

export type SubscriptionReturn =
  | { kind: "none" }
  | { kind: "cancelled" }
  | { kind: "returned"; subscriptionId: string | null };

// PayPal sends the buyer back to /?subscription=return&subscription_id=I-…
// (or ?subscription=cancel). The id only says which subscription to check;
// the server asks PayPal whether it is really active.
export function readSubscriptionReturn(search: string): SubscriptionReturn {
  const params = new URLSearchParams(search);
  const marker = params.get("subscription");
  if (marker === "cancel") return { kind: "cancelled" };
  if (marker !== "return") return { kind: "none" };
  const id = params.get("subscription_id");
  return { kind: "returned", subscriptionId: id && PAYPAL_SUBSCRIPTION_ID.test(id) ? id : null };
}

export function describeOffer(offer: SubscriptionOffer): string {
  const period = offer.interval === "MONTH" && offer.intervalCount === 1 ? "month" : offer.interval.toLowerCase();
  return `${offer.trialDays}-day free trial, then ${offer.currency} ${offer.price} per ${period} (PayPal Sandbox)`;
}

export function describeSubscription(subscription: Subscription | null): string {
  if (!subscription) return "No subscription";
  switch (subscription.status) {
    case "ACTIVE":
      return "Active";
    case "APPROVAL_PENDING":
      return "Waiting for approval in PayPal";
    case "APPROVED":
      return "Approved in PayPal; waiting for activation";
    case "SUSPENDED":
      return "Suspended by PayPal";
    case "CANCELLED":
      return "Cancelled";
    case "EXPIRED":
      return "Expired";
  }
}

// Whether the user may start a new subscription from the UI. The server
// enforces the same rule (409 for an existing subscription).
export function canStartSubscription(subscription: Subscription | null): boolean {
  return !subscription || ["APPROVAL_PENDING", "CANCELLED", "EXPIRED"].includes(subscription.status);
}

// A clear message for a refused AI request, or undefined when the error is
// not about access.
export function accessProblem(status: number, body: object): string | undefined {
  const data = body as ApiError;
  if (status === 401 || data.code === "AUTH_REQUIRED") return "Sign in to use the AI features.";
  if (data.code === "USAGE_LIMIT_REACHED") {
    const limit = (body as { limit?: unknown }).limit;
    return (body as { plan?: unknown }).plan === "PRO"
      ? `You have used all ${String(limit)} AI brief analyses for this month. The allowance starts again next month.`
      : `The Free plan includes ${String(limit)} AI brief analyses per month, and you have used them. Start the Pro free trial for 30 per month.`;
  }
  if (status === 402 || data.code === "SUBSCRIPTION_REQUIRED") {
    switch (data.subscriptionStatus) {
      case "SUSPENDED":
        return "Your subscription is suspended. Update the payment method in PayPal to continue.";
      case "CANCELLED":
      case "EXPIRED":
        return "Your subscription has ended. Subscribe again to keep using the AI features.";
      case "APPROVAL_PENDING":
      case "APPROVED":
        return "Your subscription is not active yet. Finish the approval in PayPal, then select \"Check status\".";
      default:
        return "The AI features need a subscription. Start the free trial in the account panel.";
    }
  }
  if (status === 403 && data.code === "FORBIDDEN") return "Your account does not have access to this feature.";
  if (status === 403 && data.code === "ORIGIN_REQUIRED") {
    return "The request did not come from the PayPilot web app, so it was refused. Reload the page and try again.";
  }
  if (status === 503 && data.code === "AUTH_UNAVAILABLE") return "Sign-in is temporarily unavailable. Try again shortly.";
  return undefined;
}

// The browser refused or dropped the session cookie: the server created the
// session, but the next request arrived without it. A SameSite=Lax cookie is
// refused when the app runs inside another site's frame (for example an
// editor's embedded browser preview), and some browser settings block it.
export class SessionNotKeptError extends Error {
  readonly mode: "login" | "register";

  constructor(mode: "login" | "register") {
    super(
      `${mode === "register" ? "Your account was created, but this" : "Your password was accepted, but this"} browser did not keep the sign-in cookie, so you are not signed in. ` +
        "Open the app in a normal browser tab (not an embedded preview or frame), check that cookies are allowed for the API's address, then sign in.",
    );
    this.name = "SessionNotKeptError";
    this.mode = mode;
  }
}

// ---- API calls ----------------------------------------------------------------

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

async function expectOk<T>(promise: Promise<{ response: Response; data: T & ApiError }>, fallback: string): Promise<T> {
  const { response, data } = await promise;
  if (!response.ok) throw new Error(data.error ?? fallback);
  return data;
}

export async function fetchCurrentUser(apiUrl: string): Promise<User | null> {
  const { response, data } = await requestJson<{ user?: User }>(`${apiUrl}/api/auth/me`);
  if (response.status === 401) return null;
  if (!response.ok || !data.user) throw new Error(data.error ?? "Could not load your account.");
  return data.user;
}

export async function signIn(apiUrl: string, mode: "login" | "register", email: string, password: string): Promise<User> {
  const data = await expectOk(
    requestJson<{ user?: User }>(`${apiUrl}/api/auth/${mode}`, json({ email, password })),
    mode === "login" ? "Could not sign in." : "Could not create the account.",
  );
  if (!data.user) throw new Error("The server did not return the account.");
  return data.user;
}

// Registers or signs in, then proves the session works by asking the server
// who is signed in, using only the cookie the browser kept. The sign-in
// response body alone is not proof: the browser may have refused the cookie.
export async function signInAndConfirm(
  apiUrl: string,
  mode: "login" | "register",
  email: string,
  password: string,
): Promise<User> {
  const user = await signIn(apiUrl, mode, email, password);
  const confirmed = await fetchCurrentUser(apiUrl);
  if (!confirmed || confirmed.id !== user.id) throw new SessionNotKeptError(mode);
  return confirmed;
}

export async function signOut(apiUrl: string): Promise<void> {
  await expectOk(requestJson<{ signedOut?: boolean }>(`${apiUrl}/api/auth/logout`, json({})), "Could not sign out.");
}

function toState(data: Partial<SubscriptionState>): SubscriptionState {
  return { subscription: data.subscription ?? null, offer: data.offer ?? DEFAULT_OFFER };
}

export async function fetchSubscription(apiUrl: string): Promise<SubscriptionState> {
  return toState(
    await expectOk(requestJson<Partial<SubscriptionState>>(`${apiUrl}/api/subscriptions/current`), "Could not load the subscription."),
  );
}

export async function syncSubscription(apiUrl: string, subscriptionId: string | null): Promise<SubscriptionState> {
  return toState(
    await expectOk(
      requestJson<Partial<SubscriptionState>>(
        `${apiUrl}/api/subscriptions/sync`,
        json(subscriptionId ? { subscriptionId } : {}),
      ),
      "Could not confirm the subscription with PayPal.",
    ),
  );
}

export async function startSubscription(apiUrl: string): Promise<string> {
  const data = await expectOk(
    requestJson<{ approveUrl?: string }>(`${apiUrl}/api/subscriptions`, json({})),
    "Could not start the subscription.",
  );
  if (!data.approveUrl) throw new Error("The server did not return a PayPal approval link.");
  return data.approveUrl;
}

export async function cancelSubscription(apiUrl: string): Promise<SubscriptionState> {
  return toState(
    await expectOk(requestJson<Partial<SubscriptionState>>(`${apiUrl}/api/subscriptions/cancel`, json({})), "Could not cancel the subscription."),
  );
}
