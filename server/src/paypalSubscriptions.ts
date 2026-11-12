// PayPal Subscriptions (v1 billing API) and webhook signature verification.
// Only the server calls these, with its own OAuth token; nothing here trusts
// the browser. `fetch` and the token are injected so tests can use a fake
// PayPal, and the base URL is always the Sandbox (see config.ts).

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type PayPalApiDeps = {
  fetch: FetchLike;
  baseUrl: string;
  getAccessToken: () => Promise<string>;
  timeoutMs?: number;
};

// The one subscription the app sells: USD 5.00 every month after a 7-day
// free trial. The PayPal plan is created once from this definition (npm run
// paypal:create-plan) and checked against it before any subscription is sold.
export const SUBSCRIPTION_OFFER = {
  price: "5.00",
  currency: "USD",
  interval: "MONTH",
  intervalCount: 1,
  trialDays: 7,
} as const;

export const SUBSCRIPTION_STATUSES = [
  "APPROVAL_PENDING",
  "APPROVED",
  "ACTIVE",
  "SUSPENDED",
  "CANCELLED",
  "EXPIRED",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export function isSubscriptionStatus(value: unknown): value is SubscriptionStatus {
  return typeof value === "string" && (SUBSCRIPTION_STATUSES as readonly string[]).includes(value);
}

export class PayPalApiError extends Error {
  constructor(
    message: string,
    // Not named "status": the JSON error handler would send it to the client.
    readonly paypalStatus: number | undefined,
  ) {
    super(message);
    this.name = "PayPalApiError";
  }
}

async function callPayPal(
  deps: PayPalApiDeps,
  method: "GET" | "POST",
  path: string,
  options: { body?: string; requestId?: string } = {},
): Promise<unknown> {
  const accessToken = await deps.getAccessToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.requestId) headers["PayPal-Request-Id"] = options.requestId;

  let response: Response;
  try {
    response = await deps.fetch(`${deps.baseUrl}${path}`, {
      method,
      headers,
      ...(options.body !== undefined ? { body: options.body } : {}),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000),
    });
  } catch (error) {
    throw new PayPalApiError(
      error instanceof Error && error.name === "TimeoutError" ? "PayPal did not answer in time." : "PayPal could not be reached.",
      undefined,
    );
  }
  if (response.status === 204) return undefined;
  if (!response.ok) {
    // The error body is not logged or returned: it can echo request data.
    throw new PayPalApiError(`PayPal answered HTTP ${response.status}.`, response.status);
  }
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new PayPalApiError("PayPal sent a response that is not JSON.", response.status);
  }
}

// ---- Plan -----------------------------------------------------------------

export function productDefinition() {
  return {
    name: "PayPilot AI Pro",
    description: "PayPilot AI proposal analysis, drafting and review (Sandbox test subscription).",
    type: "SERVICE",
    category: "SOFTWARE",
  };
}

// The PayPal plan body. A free trial has no pricing scheme.
export function planDefinition(productId: string) {
  return {
    product_id: productId,
    name: "PayPilot AI Pro - monthly",
    description: `USD ${SUBSCRIPTION_OFFER.price} per month after a ${SUBSCRIPTION_OFFER.trialDays}-day free trial (Sandbox).`,
    status: "ACTIVE",
    billing_cycles: [
      {
        frequency: { interval_unit: "DAY", interval_count: SUBSCRIPTION_OFFER.trialDays },
        tenure_type: "TRIAL",
        sequence: 1,
        total_cycles: 1,
      },
      {
        frequency: { interval_unit: SUBSCRIPTION_OFFER.interval, interval_count: SUBSCRIPTION_OFFER.intervalCount },
        tenure_type: "REGULAR",
        sequence: 2,
        total_cycles: 0, // Until cancelled.
        pricing_scheme: {
          fixed_price: { value: SUBSCRIPTION_OFFER.price, currency_code: SUBSCRIPTION_OFFER.currency },
        },
      },
    ],
    payment_preferences: {
      auto_bill_outstanding: true,
      setup_fee: { value: "0", currency_code: SUBSCRIPTION_OFFER.currency },
      setup_fee_failure_action: "CANCEL",
      payment_failure_threshold: 3,
    },
  };
}

type PlanCycle = {
  tenure_type?: unknown;
  sequence?: unknown;
  total_cycles?: unknown;
  frequency?: { interval_unit?: unknown; interval_count?: unknown };
  pricing_scheme?: { fixed_price?: { value?: unknown; currency_code?: unknown } };
};

function isZeroPrice(cycle: PlanCycle): boolean {
  const price = cycle.pricing_scheme?.fixed_price;
  return price === undefined || Number(price.value) === 0;
}

// Problems that make a PayPal plan differ from SUBSCRIPTION_OFFER; empty when
// it matches: ACTIVE, one 7-day free trial cycle, then USD 5.00 every month
// until cancelled, with no setup fee.
export function planProblems(plan: unknown): string[] {
  const problems: string[] = [];
  const value = (plan ?? {}) as {
    status?: unknown;
    billing_cycles?: PlanCycle[];
    payment_preferences?: { setup_fee?: { value?: unknown } };
  };
  if (value.status !== "ACTIVE") problems.push("the plan is not ACTIVE");
  const cycles = Array.isArray(value.billing_cycles) ? value.billing_cycles : [];
  const trials = cycles.filter((cycle) => cycle.tenure_type === "TRIAL");
  const regular = cycles.filter((cycle) => cycle.tenure_type === "REGULAR");

  const trial = trials[0];
  if (
    trials.length !== 1 ||
    !trial ||
    trial.frequency?.interval_unit !== "DAY" ||
    Number(trial.frequency?.interval_count) !== SUBSCRIPTION_OFFER.trialDays ||
    Number(trial.total_cycles) !== 1 ||
    !isZeroPrice(trial)
  ) {
    problems.push(`the plan must have exactly one free ${SUBSCRIPTION_OFFER.trialDays}-day trial cycle`);
  }

  const cycle = regular[0];
  const price = cycle?.pricing_scheme?.fixed_price;
  if (
    regular.length !== 1 ||
    !cycle ||
    cycle.frequency?.interval_unit !== SUBSCRIPTION_OFFER.interval ||
    Number(cycle.frequency?.interval_count) !== SUBSCRIPTION_OFFER.intervalCount ||
    Number(cycle.total_cycles) !== 0 ||
    price?.currency_code !== SUBSCRIPTION_OFFER.currency ||
    Number(price?.value) !== Number(SUBSCRIPTION_OFFER.price)
  ) {
    problems.push(
      `the plan must bill ${SUBSCRIPTION_OFFER.currency} ${SUBSCRIPTION_OFFER.price} every ${SUBSCRIPTION_OFFER.interval} until cancelled`,
    );
  }
  if (trial && cycle && !(Number(trial.sequence) < Number(cycle.sequence))) {
    problems.push("the trial must come before the monthly billing");
  }
  const setupFee = value.payment_preferences?.setup_fee?.value;
  if (setupFee !== undefined && Number(setupFee) !== 0) problems.push("the plan must have no setup fee");
  return problems;
}

export async function fetchPlan(deps: PayPalApiDeps, planId: string): Promise<unknown> {
  return callPayPal(deps, "GET", `/v1/billing/plans/${encodeURIComponent(planId)}`);
}

export async function createProductAndPlan(deps: PayPalApiDeps): Promise<{ productId: string; planId: string }> {
  const product = (await callPayPal(deps, "POST", "/v1/catalogs/products", {
    body: JSON.stringify(productDefinition()),
  })) as { id?: unknown };
  if (typeof product?.id !== "string") throw new PayPalApiError("PayPal did not return a product id.", undefined);
  const plan = (await callPayPal(deps, "POST", "/v1/billing/plans", {
    body: JSON.stringify(planDefinition(product.id)),
  })) as { id?: unknown };
  if (typeof plan?.id !== "string") throw new PayPalApiError("PayPal did not return a plan id.", undefined);
  return { productId: product.id, planId: plan.id };
}

// ---- Subscriptions --------------------------------------------------------

// What the server stores about a subscription, as PayPal reports it.
export type SubscriptionSnapshot = {
  id: string;
  status: SubscriptionStatus;
  planId: string | undefined;
  customId: string | undefined;
  statusUpdateTime: Date | undefined;
  nextBillingTime: Date | undefined;
};

function toDate(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function toSnapshot(data: unknown): SubscriptionSnapshot {
  const value = (data ?? {}) as {
    id?: unknown;
    status?: unknown;
    plan_id?: unknown;
    custom_id?: unknown;
    status_update_time?: unknown;
    create_time?: unknown;
    billing_info?: { next_billing_time?: unknown };
  };
  if (typeof value.id !== "string" || !isSubscriptionStatus(value.status)) {
    throw new PayPalApiError("PayPal returned a subscription without a valid id or status.", undefined);
  }
  return {
    id: value.id,
    status: value.status,
    planId: typeof value.plan_id === "string" ? value.plan_id : undefined,
    customId: typeof value.custom_id === "string" ? value.custom_id : undefined,
    statusUpdateTime: toDate(value.status_update_time) ?? toDate(value.create_time),
    nextBillingTime: toDate(value.billing_info?.next_billing_time),
  };
}

export async function createPayPalSubscription(
  deps: PayPalApiDeps,
  input: { planId: string; customId: string; returnUrl: string; cancelUrl: string },
): Promise<{ snapshot: SubscriptionSnapshot; approveUrl: string | undefined }> {
  const data = (await callPayPal(deps, "POST", "/v1/billing/subscriptions", {
    // The internal subscription id doubles as the idempotency key, so a
    // retried request returns the same PayPal subscription.
    requestId: input.customId,
    body: JSON.stringify({
      plan_id: input.planId,
      custom_id: input.customId,
      application_context: {
        brand_name: "PayPilot AI",
        shipping_preference: "NO_SHIPPING",
        user_action: "SUBSCRIBE_NOW",
        return_url: input.returnUrl,
        cancel_url: input.cancelUrl,
      },
    }),
  })) as { links?: Array<{ rel?: unknown; href?: unknown }> };
  const approve = data?.links?.find((link) => link.rel === "approve")?.href;
  return { snapshot: toSnapshot(data), approveUrl: typeof approve === "string" ? approve : undefined };
}

export async function getPayPalSubscription(deps: PayPalApiDeps, id: string): Promise<SubscriptionSnapshot> {
  return toSnapshot(await callPayPal(deps, "GET", `/v1/billing/subscriptions/${encodeURIComponent(id)}`));
}

export async function cancelPayPalSubscription(deps: PayPalApiDeps, id: string, reason: string): Promise<void> {
  await callPayPal(deps, "POST", `/v1/billing/subscriptions/${encodeURIComponent(id)}/cancel`, {
    body: JSON.stringify({ reason: reason.slice(0, 128) }),
  });
}

// ---- Webhooks -------------------------------------------------------------

export const WEBHOOK_HEADERS = {
  authAlgo: "paypal-auth-algo",
  certUrl: "paypal-cert-url",
  transmissionId: "paypal-transmission-id",
  transmissionSig: "paypal-transmission-sig",
  transmissionTime: "paypal-transmission-time",
} as const;

export type WebhookHeaders = { -readonly [K in keyof typeof WEBHOOK_HEADERS]: string };

export function readWebhookHeaders(get: (name: string) => string | undefined): WebhookHeaders | undefined {
  const result: Partial<WebhookHeaders> = {};
  for (const [key, name] of Object.entries(WEBHOOK_HEADERS) as Array<[keyof WebhookHeaders, string]>) {
    const value = get(name);
    if (!value || value.length > 2048) return undefined;
    result[key] = value;
  }
  return result as WebhookHeaders;
}

// The certificate must come from PayPal over HTTPS; PayPal's verification
// API checks it too, this only refuses obviously forged headers early.
export function isPayPalCertUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "paypal.com" || url.hostname.endsWith(".paypal.com"));
  } catch {
    return false;
  }
}

// Asks PayPal whether the delivery is genuine. The event is passed exactly as
// received (the raw body text), because PayPal signs those bytes and a
// re-serialized copy may not match.
export async function verifyWebhookSignature(
  deps: PayPalApiDeps,
  input: { headers: WebhookHeaders; rawBody: string; webhookId: string },
): Promise<boolean> {
  if (!isPayPalCertUrl(input.headers.certUrl)) return false;
  const body =
    `{"auth_algo":${JSON.stringify(input.headers.authAlgo)},` +
    `"cert_url":${JSON.stringify(input.headers.certUrl)},` +
    `"transmission_id":${JSON.stringify(input.headers.transmissionId)},` +
    `"transmission_sig":${JSON.stringify(input.headers.transmissionSig)},` +
    `"transmission_time":${JSON.stringify(input.headers.transmissionTime)},` +
    `"webhook_id":${JSON.stringify(input.webhookId)},` +
    `"webhook_event":${input.rawBody}}`;
  const data = (await callPayPal(deps, "POST", "/v1/notifications/verify-webhook-signature", { body })) as {
    verification_status?: unknown;
  };
  return data?.verification_status === "SUCCESS";
}
