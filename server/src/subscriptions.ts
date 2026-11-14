// PayPal subscriptions: creation, approval return, status sync, cancellation,
// verified webhooks, and the entitlement check for paid features.
//
// Entitlement changes only on data the server got from PayPal itself: the
// subscription read from PayPal's API with the server's own credentials, or a
// webhook whose signature PayPal has verified. Even a verified webhook is
// used only as a trigger: the server reads the subscription's current state
// from PayPal, so events delivered late or out of order cannot move it to an
// older state. The browser's return from PayPal proves nothing by itself.
import express, { type Request, type RequestHandler } from "express";
import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { tryAudit, writeAudit } from "./auditLog.js";
import { getAuth, type AuthModule } from "./auth.js";
import type { HandlerTracker } from "./gracefulShutdown.js";
import { isPayPalApprovalUrl } from "./checkoutRoute.js";
import {
  PayPalApiError,
  SUBSCRIPTION_OFFER,
  cancelPayPalSubscription,
  createPayPalSubscription,
  fetchPlan,
  getPayPalSaleSubscriptionId,
  getPayPalSubscription,
  planProblems,
  readWebhookHeaders,
  verifyWebhookSignature,
  type PayPalApiDeps,
  type SubscriptionSnapshot,
  type SubscriptionStatus,
} from "./paypalSubscriptions.js";
import { createRateLimiter } from "./rateLimit.js";
import { withTransaction } from "./transaction.js";

type Logger = {
  error: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
};

export const WEBHOOK_PATH = "/api/paypal/webhooks";

// express.json's `verify` hook: keeps the exact bytes of a webhook delivery,
// which PayPal's signature covers.
export function keepRawWebhookBody(req: IncomingMessage, _res: unknown, buffer: Buffer): void {
  const url = req.url ?? "";
  if (url === WEBHOOK_PATH || url.startsWith(`${WEBHOOK_PATH}?`)) {
    (req as IncomingMessage & { rawBody?: string }).rawBody = buffer.toString("utf8");
  }
}

// Statuses PayPal can still change. CANCELLED and EXPIRED are final.
const OPEN_STATUSES: SubscriptionStatus[] = ["APPROVAL_PENDING", "APPROVED", "ACTIVE", "SUSPENDED"];
const FINAL_STATUSES = new Set<SubscriptionStatus>(["CANCELLED", "EXPIRED"]);

export type SubscriptionRow = {
  id: string;
  user_id: string;
  paypal_subscription_id: string | null;
  plan_id: string;
  status: SubscriptionStatus;
  paypal_status_updated_at: Date | null;
  next_billing_time: Date | null;
  last_verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export function subscriptionView(row: SubscriptionRow | undefined) {
  return {
    subscription: row
      ? {
          id: row.id,
          status: row.status,
          entitled: row.status === "ACTIVE",
          nextBillingTime: row.next_billing_time?.toISOString() ?? null,
          lastVerifiedAt: row.last_verified_at?.toISOString() ?? null,
        }
      : null,
    offer: SUBSCRIPTION_OFFER,
  };
}

export const SUBSCRIPTION_REQUIRED = {
  error: "An active PayPilot AI subscription is required. Start the 7-day free trial to continue.",
  code: "SUBSCRIPTION_REQUIRED",
} as const;

class SubscriptionMismatch extends Error {}

export type SubscriptionModuleOptions = {
  pool: Pool;
  auth: AuthModule;
  payPal: PayPalApiDeps;
  planId: string | undefined;
  webhookId: string | undefined;
  allowedOrigins: string[];
  now?: () => number;
  // How old the stored state of an ACTIVE subscription may be before the
  // entitlement check re-reads it from PayPal (in case a webhook was lost).
  entitlementRecheckMs?: number;
  // How old the state may be before GET /api/subscriptions/current re-reads it.
  viewRefreshMs?: number;
  limits?: { createPer10MinutesPerClient?: number };
  trackHandler?: HandlerTracker;
  logger?: Logger;
};

export function createSubscriptionModule(options: SubscriptionModuleOptions) {
  const { pool, auth, payPal } = options;
  const now = options.now ?? Date.now;
  const track: HandlerTracker = options.trackHandler ?? ((handler) => handler);
  const logger = options.logger ?? console;
  const recheckMs = options.entitlementRecheckMs ?? 6 * 3_600_000;
  const viewRefreshMs = options.viewRefreshMs ?? 10 * 60_000;

  // ---- Plan check -----------------------------------------------------------
  let planCheck: Promise<string[]> | undefined;
  function checkPlan(planId: string): Promise<string[]> {
    planCheck ??= fetchPlan(payPal, planId)
      .then(planProblems)
      .catch((error: unknown) => {
        planCheck = undefined; // Retry next time; PayPal may be briefly down.
        throw error;
      });
    return planCheck;
  }

  // ---- Store ----------------------------------------------------------------

  async function latestFor(userId: string, statuses?: SubscriptionStatus[]): Promise<SubscriptionRow | undefined> {
    const result = statuses
      ? await pool.query<SubscriptionRow>(
          `SELECT * FROM subscriptions WHERE user_id = $1 AND status = ANY($2::text[])
            ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
          [userId, statuses],
        )
      : await pool.query<SubscriptionRow>(
          `SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
          [userId],
        );
    return result.rows[0];
  }

  // Stores a snapshot read from PayPal, under a row lock. Refuses a snapshot
  // for a different subscription, plan or owner; never replaces newer state
  // with older; never reopens a CANCELLED or EXPIRED subscription.
  async function applySnapshot(
    rowId: string,
    snapshot: SubscriptionSnapshot,
    source: "create" | "sync" | "webhook" | "cancel" | "recheck",
  ): Promise<SubscriptionRow | undefined> {
    return withTransaction(pool, async (client) => {
      const row = (await client.query<SubscriptionRow>(`SELECT * FROM subscriptions WHERE id = $1 FOR UPDATE`, [rowId]))
        .rows[0];
      if (!row) return undefined;
      if (
        (row.paypal_subscription_id !== null && row.paypal_subscription_id !== snapshot.id) ||
        (snapshot.customId !== undefined && snapshot.customId !== row.id) ||
        (snapshot.planId !== undefined && snapshot.planId !== row.plan_id)
      ) {
        throw new SubscriptionMismatch("The PayPal subscription does not belong to this record.");
      }
      const verifiedAt = new Date(now());
      const older =
        row.paypal_status_updated_at !== null &&
        snapshot.statusUpdateTime !== undefined &&
        snapshot.statusUpdateTime < row.paypal_status_updated_at;
      const reopening = FINAL_STATUSES.has(row.status) && !FINAL_STATUSES.has(snapshot.status);
      if (older || reopening) {
        const kept = await client.query<SubscriptionRow>(
          `UPDATE subscriptions SET last_verified_at = $2 WHERE id = $1 RETURNING *`,
          [row.id, verifiedAt],
        );
        return kept.rows[0];
      }
      const updated = await client.query<SubscriptionRow>(
        `UPDATE subscriptions
            SET paypal_subscription_id = $2,
                status = $3,
                paypal_status_updated_at = COALESCE($4, paypal_status_updated_at),
                next_billing_time = $5,
                last_verified_at = $6,
                updated_at = $6
          WHERE id = $1
          RETURNING *`,
        [row.id, snapshot.id, snapshot.status, snapshot.statusUpdateTime ?? null, snapshot.nextBillingTime ?? null, verifiedAt],
      );
      if (row.status !== snapshot.status) {
        await writeAudit(client, {
          actorUserId: row.user_id,
          action: "subscription.status.change",
          resourceType: "subscription",
          resourceId: row.id,
          outcome: "success",
          metadata: { previousStatus: row.status, status: snapshot.status, source },
        });
      }
      return updated.rows[0];
    });
  }

  async function refreshFromPayPal(
    row: SubscriptionRow,
    source: "sync" | "webhook" | "cancel" | "recheck",
  ): Promise<SubscriptionRow | undefined> {
    if (!row.paypal_subscription_id) return row;
    const snapshot = await getPayPalSubscription(payPal, row.paypal_subscription_id);
    return applySnapshot(row.id, snapshot, source);
  }

  const isStale = (row: SubscriptionRow, maxAgeMs: number) =>
    !row.last_verified_at || now() - row.last_verified_at.getTime() > maxAgeMs;

  // ---- Entitlement ----------------------------------------------------------

  // For paid routes, after auth.requireUser and a permission check: lets the
  // request through only for a user with an ACTIVE subscription (the free
  // trial counts: PayPal reports a subscription in its trial as ACTIVE).
  // Whether the user has an ACTIVE subscription, as last verified with
  // PayPal (re-read from PayPal when that is older than recheckMs). The free
  // trial counts: PayPal reports a subscription in its trial as ACTIVE.
  async function hasActiveSubscription(userId: string): Promise<boolean> {
    let active = await latestFor(userId, ["ACTIVE"]);
    if (active && isStale(active, recheckMs)) {
      try {
        active = await refreshFromPayPal(active, "recheck");
      } catch (error) {
        // PayPal unreachable: keep the last verified state.
        logger.error("Subscription recheck failed:", error instanceof Error ? error.message : "unknown error");
      }
    }
    return active?.status === "ACTIVE";
  }

  const requireEntitlement: RequestHandler = async (_req, res, next) => {
    const user = getAuth(res);
    if (!user) {
      res.status(401).json({ error: "Sign in to continue.", code: "AUTH_REQUIRED" });
      return;
    }
    if (await hasActiveSubscription(user.userId)) return next();
    const latest = await latestFor(user.userId);
    res.status(402).json({ ...SUBSCRIPTION_REQUIRED, subscriptionStatus: latest?.status ?? null });
  };

  // ---- Routes ---------------------------------------------------------------

  const router = express.Router();
  router.use("/api/subscriptions", auth.requireTrustedOrigin);

  const createLimiter = createRateLimiter({
    now,
    rules: [
      {
        scope: "client",
        windowMs: 10 * 60_000,
        max: options.limits?.createPer10MinutesPerClient ?? 10,
        message: "Too many subscription attempts. Wait a few minutes and try again.",
      },
    ],
  });
  const syncLimiter = createRateLimiter({
    now,
    rules: [{ scope: "client", windowMs: 60_000, max: 30, message: "Too many subscription checks. Wait a moment." }],
  });

  const allowed = options.allowedOrigins;
  function returnOrigin(req: Request): string | undefined {
    const origin = req.get("origin");
    return origin && allowed.includes(origin) ? origin : allowed[0];
  }

  router.get(
    "/api/subscriptions/current",
    auth.requireUser,
    auth.requirePermission("subscription:read"),
    syncLimiter,
    track(async (_req, res) => {
      const user = getAuth(res)!;
      let row = await latestFor(user.userId);
      if (row && OPEN_STATUSES.includes(row.status) && isStale(row, viewRefreshMs)) {
        try {
          row = (await refreshFromPayPal(row, "sync")) ?? row;
        } catch (error) {
          logger.error("Subscription refresh failed:", error instanceof Error ? error.message : "unknown error");
        }
      }
      return res.json(subscriptionView(row));
    }),
  );

  router.post(
    "/api/subscriptions",
    auth.requireUser,
    auth.requirePermission("subscription:manage"),
    createLimiter,
    track(async (req, res) => {
      const user = getAuth(res)!;
      const planId = options.planId;
      const origin = returnOrigin(req);
      if (!planId || !origin) {
        return res.status(503).json({ error: "Subscriptions are not configured on this server.", code: "NOT_CONFIGURED" });
      }

      const current = await latestFor(user.userId, ["ACTIVE", "APPROVED", "SUSPENDED"]);
      if (current) {
        return res.status(409).json({
          error:
            current.status === "SUSPENDED"
              ? "Your subscription is suspended. Update the payment method in PayPal to resume it."
              : "You already have a subscription.",
          code: "ALREADY_SUBSCRIBED",
          ...subscriptionView(current),
        });
      }

      let problems: string[];
      try {
        problems = await checkPlan(planId);
      } catch (error) {
        logger.error("Subscription plan check failed:", error instanceof Error ? error.message : "unknown error");
        return res.status(502).json({ error: "Could not reach PayPal. Try again shortly.", code: "PAYPAL_UNAVAILABLE" });
      }
      if (problems.length > 0) {
        logger.error("The configured PayPal plan does not match the offer:", problems);
        return res.status(503).json({ error: "The subscription plan is misconfigured on this server.", code: "PLAN_MISCONFIGURED" });
      }

      // Recorded before PayPal is called, so its id (sent as custom_id) can
      // be matched to the user when PayPal reports back.
      const id = randomUUID();
      await pool.query(
        `INSERT INTO subscriptions (id, user_id, plan_id, status) VALUES ($1, $2, $3, 'APPROVAL_PENDING')`,
        [id, user.userId, planId],
      );

      let created: Awaited<ReturnType<typeof createPayPalSubscription>>;
      try {
        created = await createPayPalSubscription(payPal, {
          planId,
          customId: id,
          returnUrl: `${origin}/?subscription=return`,
          cancelUrl: `${origin}/?subscription=cancel`,
        });
        if (!isPayPalApprovalUrl(created.approveUrl)) {
          throw new PayPalApiError("PayPal returned no usable approval link.", undefined);
        }
      } catch (error) {
        await pool.query(`DELETE FROM subscriptions WHERE id = $1 AND paypal_subscription_id IS NULL`, [id]);
        await tryAudit(pool, {
          actorUserId: user.userId,
          action: "subscription.create",
          resourceType: "subscription",
          resourceId: id,
          outcome: "failure",
          metadata: { reason: error instanceof Error ? error.message : "unknown error" },
        });
        return res.status(502).json({ error: "PayPal could not start the subscription. Try again.", code: "PAYPAL_UNAVAILABLE" });
      }

      const row = await applySnapshot(id, created.snapshot, "create");
      await tryAudit(pool, {
        actorUserId: user.userId,
        action: "subscription.create",
        resourceType: "subscription",
        resourceId: id,
        outcome: "success",
        metadata: { status: created.snapshot.status, planId },
      });
      return res.status(201).json({ approveUrl: created.approveUrl, ...subscriptionView(row) });
    }),
  );

  const SyncSchema = z.object({
    subscriptionId: z.string().regex(/^I-[A-Z0-9]{6,40}$/).optional(),
  });

  // After the PayPal return (or any time): reads the subscription from PayPal
  // and stores what PayPal reports. A PayPal id that is not this user's gets
  // the same 404 as an unknown one.
  router.post(
    "/api/subscriptions/sync",
    auth.requireUser,
    auth.requirePermission("subscription:read"),
    syncLimiter,
    track(async (req, res) => {
      const user = getAuth(res)!;
      const parsed = SyncSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: "The subscription id is not valid.", code: "INVALID_INPUT" });
      const row = parsed.data.subscriptionId
        ? (
            await pool.query<SubscriptionRow>(
              `SELECT * FROM subscriptions WHERE paypal_subscription_id = $1 AND user_id = $2`,
              [parsed.data.subscriptionId, user.userId],
            )
          ).rows[0]
        : await latestFor(user.userId);
      if (!row) return res.status(404).json({ error: "No such subscription for this account.", code: "NOT_FOUND" });
      try {
        const refreshed = await refreshFromPayPal(row, "sync");
        return res.json(subscriptionView(refreshed ?? row));
      } catch (error) {
        logger.error("Subscription sync failed:", error instanceof Error ? error.message : "unknown error");
        return res.status(502).json({ error: "Could not confirm the subscription with PayPal. Try again.", code: "PAYPAL_UNAVAILABLE", ...subscriptionView(row) });
      }
    }),
  );

  router.post(
    "/api/subscriptions/cancel",
    auth.requireUser,
    auth.requirePermission("subscription:manage"),
    createLimiter,
    track(async (_req, res) => {
      const user = getAuth(res)!;
      const row = await latestFor(user.userId, ["ACTIVE", "APPROVED", "SUSPENDED"]);
      if (!row?.paypal_subscription_id) {
        return res.status(404).json({ error: "There is no active subscription to cancel.", code: "NOT_FOUND" });
      }
      try {
        await cancelPayPalSubscription(payPal, row.paypal_subscription_id, "Cancelled by the subscriber in PayPilot AI.");
        const refreshed = await refreshFromPayPal(row, "cancel");
        await tryAudit(pool, {
          actorUserId: user.userId,
          action: "subscription.cancel",
          resourceType: "subscription",
          resourceId: row.id,
          outcome: "success",
        });
        return res.json(subscriptionView(refreshed ?? row));
      } catch (error) {
        await tryAudit(pool, {
          actorUserId: user.userId,
          action: "subscription.cancel",
          resourceType: "subscription",
          resourceId: row.id,
          outcome: "failure",
          metadata: { reason: error instanceof Error ? error.message : "unknown error" },
        });
        return res.status(502).json({ error: "PayPal could not cancel the subscription. Try again.", code: "PAYPAL_UNAVAILABLE" });
      }
    }),
  );

  // ---- Webhooks -------------------------------------------------------------

  const webhookLimiter = createRateLimiter({
    now,
    rules: [{ scope: "global", windowMs: 60_000, max: 300, message: "Too many webhook deliveries." }],
  });

  const EventSchema = z.object({
    id: z.string().min(1).max(100),
    event_type: z.string().min(1).max(100),
    create_time: z.string().max(40).optional(),
    resource: z
      .object({ id: z.string().max(100).optional(), custom_id: z.string().max(127).optional() })
      .loose()
      .optional(),
  });

  const STALE_CLAIM_MS = 5 * 60_000;

  // Idempotency: one row per PayPal event id. Returns whether this delivery
  // may process the event.
  async function claimEvent(event: z.infer<typeof EventSchema>): Promise<"claimed" | "duplicate" | "busy"> {
    return withTransaction(pool, async (client) => {
      const time = new Date(now());
      const createdAt = event.create_time && !Number.isNaN(Date.parse(event.create_time)) ? new Date(event.create_time) : null;
      const inserted = await client.query(
        `INSERT INTO paypal_webhook_events (event_id, event_type, resource_id, event_created_at, status, received_at, locked_at)
         VALUES ($1, $2, $3, $4, 'PROCESSING', $5, $5)
         ON CONFLICT (event_id) DO NOTHING`,
        [event.id, event.event_type, event.resource?.id ?? null, createdAt, time],
      );
      if (inserted.rowCount === 1) return "claimed";
      const existing = (
        await client.query<{ status: string; locked_at: Date }>(
          `SELECT status, locked_at FROM paypal_webhook_events WHERE event_id = $1 FOR UPDATE`,
          [event.id],
        )
      ).rows[0];
      if (!existing) return "busy";
      if (existing.status === "PROCESSED" || existing.status === "IGNORED") return "duplicate";
      if (existing.status === "PROCESSING" && time.getTime() - existing.locked_at.getTime() < STALE_CLAIM_MS) return "busy";
      await client.query(
        `UPDATE paypal_webhook_events SET status = 'PROCESSING', attempts = attempts + 1, locked_at = $2, error = NULL
          WHERE event_id = $1`,
        [event.id, time],
      );
      return "claimed";
    });
  }

  async function finishEvent(eventId: string, status: "PROCESSED" | "IGNORED" | "FAILED", error?: string) {
    await pool.query(
      `UPDATE paypal_webhook_events SET status = $2, processed_at = $3, error = $4 WHERE event_id = $1`,
      [eventId, status, status === "FAILED" ? null : new Date(now()), error?.slice(0, 200) ?? null],
    );
  }

  // PayPal ids that are safe to put in an API path and a database lookup.
  const SUBSCRIPTION_ID = /^I-[A-Z0-9]{6,40}$/;
  const SALE_ID = /^[A-Z0-9]{6,40}$/;
  // Subscription payment events. Like every event, each one only triggers a
  // re-read of the subscription from PayPal: a payment never grants, extends
  // or removes Pro by itself; PayPal's subscription status decides.
  const SALE_EVENTS = new Set(["PAYMENT.SALE.COMPLETED", "PAYMENT.SALE.REFUNDED", "PAYMENT.SALE.REVERSED"]);

  const text = (value: unknown) => (typeof value === "string" && value.length <= 100 ? value : undefined);

  type Outcome = "processed" | "ignored" | "duplicate" | "rejected" | "retry" | "failed";

  // One log line per delivery: the event id, type and outcome (with a short
  // reason or the resulting status). Never the payload, the headers, PayPal's
  // answers, or any payment detail.
  function logDelivery(outcome: Outcome, fields: { eventId?: string; eventType?: string; reason?: string; status?: string }) {
    const line = { outcome, ...fields };
    if (outcome === "retry" || outcome === "failed") logger.error("PayPal webhook:", line);
    else if (outcome === "rejected") (logger.warn ?? logger.error)("PayPal webhook:", line);
    else (logger.info ?? logger.warn)?.("PayPal webhook:", line);
  }

  // The PayPal subscription an event is about, or why it is not about one.
  // A refund or reversal names only the sale, so PayPal is asked which
  // subscription that sale paid (with the server's own credentials).
  async function subscriptionIdOf(
    eventType: string,
    resource: Record<string, unknown>,
  ): Promise<{ subscriptionId: string } | { ignore: string }> {
    let id: string | undefined;
    if (eventType.startsWith("BILLING.SUBSCRIPTION.")) {
      id = text(resource.id);
    } else if (SALE_EVENTS.has(eventType)) {
      id = text(resource.billing_agreement_id);
      if (!id && eventType !== "PAYMENT.SALE.COMPLETED") {
        const saleId = text(resource.sale_id) ?? text(resource.id);
        if (saleId && SALE_ID.test(saleId)) id = await getPayPalSaleSubscriptionId(payPal, saleId);
      }
      if (!id) return { ignore: "not a subscription payment" };
    } else {
      return { ignore: "unsupported event type" };
    }
    return id && SUBSCRIPTION_ID.test(id) ? { subscriptionId: id } : { ignore: "no valid subscription id" };
  }

  router.post(WEBHOOK_PATH, webhookLimiter, track(async (req, res) => {
    const webhookId = options.webhookId;
    if (!webhookId) {
      logger.error("A PayPal webhook arrived, but PAYPAL_WEBHOOK_ID is not set; it was rejected.");
      return res.status(503).json({ error: "Webhooks are not configured." });
    }
    const rawBody = (req as Request & { rawBody?: string }).rawBody;
    const headers = readWebhookHeaders((name) => req.get(name));
    const event = EventSchema.safeParse(req.body);
    if (!rawBody || !headers || !event.success) {
      logDelivery("rejected", { reason: "malformed delivery" });
      await tryAudit(pool, {
        actorUserId: null,
        action: "webhook.process",
        resourceType: "paypal_webhook",
        outcome: "failure",
        metadata: { reason: "malformed" },
      });
      return res.status(400).json({ error: "Not a valid PayPal webhook delivery." });
    }
    const { id: eventId, event_type: eventType } = event.data;
    const resource = (event.data.resource ?? {}) as Record<string, unknown>;

    let genuine: boolean;
    try {
      genuine = await verifyWebhookSignature(payPal, { headers, rawBody, webhookId });
    } catch (error) {
      logger.error("Webhook signature check failed:", error instanceof Error ? error.message : "unknown error");
      logDelivery("retry", { eventId, eventType, reason: "signature check unavailable" });
      // PayPal retries deliveries that do not get a 2xx answer.
      return res.status(503).json({ error: "Could not verify the delivery; retry later." });
    }
    if (!genuine) {
      logDelivery("rejected", { eventId, eventType, reason: "invalid signature" });
      await tryAudit(pool, {
        actorUserId: null,
        action: "webhook.process",
        resourceType: "paypal_webhook",
        resourceId: eventId,
        outcome: "failure",
        metadata: { reason: "invalid_signature", eventType },
      });
      return res.status(400).json({ error: "The webhook signature is not valid." });
    }

    // From here on the event is genuine. Recording it first makes a
    // redelivery (or a concurrent second delivery) a no-op.
    let claim: Awaited<ReturnType<typeof claimEvent>>;
    try {
      claim = await claimEvent(event.data);
    } catch (error) {
      logger.error("Webhook event could not be recorded:", error instanceof Error ? error.message : "unknown error");
      logDelivery("retry", { eventId, eventType, reason: "database unavailable" });
      return res.status(503).json({ error: "The event could not be recorded; retry later." });
    }
    if (claim === "duplicate") {
      logDelivery("duplicate", { eventId, eventType });
      await tryAudit(pool, {
        actorUserId: null,
        action: "webhook.process",
        resourceType: "paypal_webhook",
        resourceId: eventId,
        outcome: "success",
        metadata: { eventType, duplicate: true },
      });
      return res.json({ received: true, duplicate: true });
    }
    if (claim === "busy") {
      logDelivery("retry", { eventId, eventType, reason: "already being processed" });
      return res.status(503).json({ error: "This event is already being processed; retry later." });
    }

    try {
      const link = await subscriptionIdOf(eventType, resource);
      if ("ignore" in link) {
        await finishEvent(eventId, "IGNORED", link.ignore);
        logDelivery("ignored", { eventId, eventType, reason: link.ignore });
        return res.json({ received: true, ignored: true });
      }
      // A subscription event may name the record by custom_id before the
      // PayPal id is stored; a payment event is matched by the PayPal id only.
      const customId = eventType.startsWith("BILLING.SUBSCRIPTION.") ? text(resource.custom_id) : undefined;
      const row = (
        await pool.query<SubscriptionRow>(
          `SELECT * FROM subscriptions
            WHERE paypal_subscription_id = $1
               OR (paypal_subscription_id IS NULL AND id::text = $2)
            LIMIT 1`,
          [link.subscriptionId, customId ?? ""],
        )
      ).rows[0];
      if (!row) {
        await finishEvent(eventId, "IGNORED", "unknown subscription");
        logDelivery("ignored", { eventId, eventType, reason: "unknown subscription" });
        return res.json({ received: true, ignored: true });
      }
      // The event says something changed; PayPal's API says what is true now.
      const snapshot = await getPayPalSubscription(payPal, link.subscriptionId);
      const updated = await applySnapshot(row.id, snapshot, "webhook");
      await finishEvent(eventId, "PROCESSED");
      const status = updated?.status ?? snapshot.status;
      logDelivery("processed", { eventId, eventType, status });
      await tryAudit(pool, {
        actorUserId: row.user_id,
        action: "webhook.process",
        resourceType: "subscription",
        resourceId: row.id,
        outcome: "success",
        metadata: {
          eventType,
          eventId,
          status,
          ...(SALE_EVENTS.has(eventType) && text(resource.state) ? { paymentState: text(resource.state) } : {}),
        },
      });
      return res.json({ received: true });
    } catch (error) {
      const reason = error instanceof SubscriptionMismatch ? "subscription mismatch" : error instanceof Error ? error.message : "unknown error";
      await finishEvent(eventId, "FAILED", reason).catch(() => undefined);
      await tryAudit(pool, {
        actorUserId: null,
        action: "webhook.process",
        resourceType: "paypal_webhook",
        resourceId: eventId,
        outcome: "failure",
        metadata: { reason, eventType },
      });
      if (error instanceof SubscriptionMismatch) {
        // Retrying cannot fix a mismatch; acknowledge and keep the record.
        logDelivery("ignored", { eventId, eventType, reason });
        return res.json({ received: true, ignored: true });
      }
      logDelivery("failed", { eventId, eventType, reason: "processing failed; PayPal will retry" });
      return res.status(500).json({ error: "The event could not be processed; retry later." });
    }
  }));

  return { router, requireEntitlement, hasActiveSubscription, applySnapshot };
}

export type SubscriptionModule = ReturnType<typeof createSubscriptionModule>;
