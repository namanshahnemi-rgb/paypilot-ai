// Plans and monthly AI usage.
//
// FREE: 2 AI brief analyses per calendar month (UTC); project workspace and
//   saved project history.
// PRO (an ACTIVE PayPal subscription, the free trial included): 30 analyses
//   per month, AI proposal drafting and AI risk review (requireEntitlement in
//   subscriptions.ts), saved proposals and reviews.
//
// The plan is decided on the server from the subscription state verified
// with PayPal; a CANCELLED, EXPIRED or SUSPENDED subscription is FREE.
// Usage is counted in PostgreSQL (ai_usage) with one conditional upsert, so
// repeated or concurrent requests can never go past the limit. An analysis
// that fails (no result for the user) is given back.
import express, { type RequestHandler } from "express";
import type { Pool } from "pg";
import { getAuth, type AuthModule } from "./auth.js";

export type Plan = "FREE" | "PRO";
export type UsageFeature = "analysis";

export const PLAN_LIMITS: Record<Plan, { analysesPerMonth: number }> = {
  FREE: { analysesPerMonth: 2 },
  PRO: { analysesPerMonth: 30 },
};

export const PLAN_FEATURES: Record<Plan, { proposalGeneration: boolean; riskReview: boolean; savedProposals: boolean }> = {
  FREE: { proposalGeneration: false, riskReview: false, savedProposals: false },
  PRO: { proposalGeneration: true, riskReview: true, savedProposals: true },
};

// The first day of the current calendar month in UTC, as YYYY-MM-01.
export function periodStart(nowMs: number): string {
  const date = new Date(nowMs);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

// When the current period ends (the first day of next month, UTC).
export function periodEnd(nowMs: number): string {
  const date = new Date(nowMs);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString();
}

export type UsageModuleOptions = {
  pool: Pool;
  auth: AuthModule;
  hasActiveSubscription: (userId: string) => Promise<boolean>;
  now?: () => number;
  logger?: { error: (...args: unknown[]) => void };
};

export function createUsageModule(options: UsageModuleOptions) {
  const { pool, auth } = options;
  const now = options.now ?? Date.now;
  const logger = options.logger ?? console;

  async function planFor(userId: string): Promise<Plan> {
    return (await options.hasActiveSubscription(userId)) ? "PRO" : "FREE";
  }

  async function usedThisMonth(userId: string, feature: UsageFeature): Promise<number> {
    const result = await pool.query<{ used: number }>(
      `SELECT used FROM ai_usage WHERE user_id = $1 AND period_start = $2 AND feature = $3`,
      [userId, periodStart(now()), feature],
    );
    return result.rows[0]?.used ?? 0;
  }

  // Takes one unit if the user is under the limit. Returns the new count, or
  // undefined when the limit is reached. The WHERE on the conflict branch
  // makes the check and the increment one atomic statement.
  async function consume(userId: string, feature: UsageFeature, limit: number): Promise<number | undefined> {
    const result = await pool.query<{ used: number }>(
      `INSERT INTO ai_usage (user_id, period_start, feature, used, updated_at)
       VALUES ($1, $2, $3, 1, NOW())
       ON CONFLICT (user_id, period_start, feature)
       DO UPDATE SET used = ai_usage.used + 1, updated_at = NOW()
       WHERE ai_usage.used < $4
       RETURNING used`,
      [userId, periodStart(now()), feature, limit],
    );
    return result.rows[0]?.used;
  }

  async function refund(userId: string, feature: UsageFeature, period: string): Promise<void> {
    await pool.query(
      `UPDATE ai_usage SET used = used - 1, updated_at = NOW()
        WHERE user_id = $1 AND period_start = $2 AND feature = $3 AND used > 0`,
      [userId, period, feature],
    );
  }

  async function usageFor(userId: string) {
    const plan = await planFor(userId);
    const limit = PLAN_LIMITS[plan].analysesPerMonth;
    const used = await usedThisMonth(userId, "analysis");
    return {
      plan,
      period: { start: periodStart(now()), resetsAt: periodEnd(now()) },
      analyses: { used, limit, remaining: Math.max(0, limit - used) },
      features: PLAN_FEATURES[plan],
    };
  }

  // For POST /api/proposals/analyze, after requireUser and the permission
  // check: takes one analysis from this month's allowance, or refuses with
  // the plan's limit. If the request then fails (any 4xx or 5xx, such as an
  // invalid brief or an AI error), the analysis is given back.
  const analysisQuota: RequestHandler = async (_req, res, next) => {
    const user = getAuth(res);
    if (!user) {
      res.status(401).json({ error: "Sign in to continue.", code: "AUTH_REQUIRED" });
      return;
    }
    const plan = await planFor(user.userId);
    const limit = PLAN_LIMITS[plan].analysesPerMonth;
    const period = periodStart(now());
    const used = await consume(user.userId, "analysis", limit);
    if (used === undefined) {
      const body = {
        code: "USAGE_LIMIT_REACHED",
        plan,
        feature: "analysis",
        limit,
        used: limit,
        resetsAt: periodEnd(now()),
      };
      if (plan === "FREE") {
        res.status(402).json({
          ...body,
          error: `The Free plan includes ${limit} AI brief analyses per month. Start the Pro free trial for ${PLAN_LIMITS.PRO.analysesPerMonth} per month.`,
        });
      } else {
        res.setHeader("Retry-After", String(Math.max(1, Math.ceil((Date.parse(body.resetsAt) - now()) / 1000))));
        res.status(429).json({ ...body, error: `You have used all ${limit} AI brief analyses for this month.` });
      }
      return;
    }
    res.on("finish", () => {
      if (res.statusCode >= 400) {
        refund(user.userId, "analysis", period).catch((error: unknown) => {
          logger.error("Usage refund failed:", error instanceof Error ? error.message : "unknown error");
        });
      }
    });
    next();
  };

  const router = express.Router();
  router.get("/api/usage", auth.requireUser, async (_req, res) => {
    res.json(await usageFor(getAuth(res)!.userId));
  });

  return { router, analysisQuota, usageFor, planFor };
}

export type UsageModule = ReturnType<typeof createUsageModule>;
