import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { z } from "zod";
import { capturePayPalOrder } from "./paypalCapture.js";
import {
  PostgresOrderRegistry,
  createPostgresPool,
} from "./postgresOrderRegistry.js";
import { createPaymentRouter } from "./paymentRoutes.js";
import { createCheckoutRouter } from "./checkoutRoute.js";
import { createRateLimiter, readLimit, readTrustProxy } from "./rateLimit.js";
import { parseClientOrigins, readPayPalBaseUrl } from "./config.js";
import { createCachedCheck, type HealthResult } from "./healthCache.js";
import {
  corsOptions,
  notFoundHandler,
  rejectDisallowedOrigins,
  requireJsonBody,
  securityHeaders,
} from "./securityMiddleware.js";
import { generateProposalDraft } from "./proposalGenerator.js";
import { analyzeBrief } from "./analysis.js";
import { ReviewRequestSchema, reviewProposalWithAI } from "./riskReview.js";
import { jsonErrorHandler } from "./httpErrors.js";
import { DEFAULT_GEMINI_MODEL, resolveProvider } from "./localModel.js";
import { createGracefulShutdown, readShutdownGraceMs } from "./gracefulShutdown.js";
import { createAuthModule, readSessionCookieConfig } from "./auth.js";
import { migrateAccountSchema } from "./accountSchema.js";
import { createSubscriptionModule, keepRawWebhookBody } from "./subscriptions.js";
import { createAdminRouter } from "./adminRoutes.js";
import { createUsageModule } from "./usage.js";
import { createProjectRouter } from "./projects.js";

dotenv.config();

// PayPal orders are stored in PostgreSQL. The connection string stays on the
// server and is never logged.
const DATABASE_URL = process.env.DATABASE_URL?.trim();
if (!DATABASE_URL) {
  console.error(
    "DATABASE_URL is not set. Add the PostgreSQL connection string to server/.env (see .env.example). The server was not started.",
  );
  process.exit(1);
}

// PayPal Sandbox only: any other PAYPAL_BASE_URL stops the server.
let PAYPAL_BASE_URL: string;
try {
  PAYPAL_BASE_URL = readPayPalBaseUrl(process.env.PAYPAL_BASE_URL);
} catch (error) {
  console.error(error instanceof Error ? error.message : "PAYPAL_BASE_URL is invalid.", "The server was not started.");
  process.exit(1);
}

const app = express();
const PORT = Number(process.env.PORT) || 4000;
const OLLAMA_URL = "http://localhost:11434";
const OLLAMA_MODEL = "qwen2.5:3b";
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta";

// Exact browser origins allowed to use the API (see config.ts). Vite uses
// 5173 by default and falls back to 5174 when 5173 is already taken.
const CLIENT_ORIGINS = parseClientOrigins(process.env.CLIENT_ORIGINS);

// Off unless TRUST_PROXY is set; see readTrustProxy in rateLimit.ts.
app.set("trust proxy", readTrustProxy(process.env.TRUST_PROXY));
app.disable("x-powered-by");

// Limits for the public endpoints (see rateLimit.ts and README.md, "Request
// limits"). Without TRUST_PROXY, "client" limits behind a proxy are shared
// by every client.
const MINUTE = 60_000;

// The three AI routes share one budget, which protects the Gemini free-tier
// quota. One analysis can make two model calls (a retry after malformed
// output), so set these to at most half of the key's limits in AI Studio.
const AI_REQUESTS_PER_MINUTE = readLimit(process.env.AI_REQUESTS_PER_MINUTE, 5, "AI_REQUESTS_PER_MINUTE");
const AI_DAILY_REQUEST_LIMIT = readLimit(process.env.AI_DAILY_REQUEST_LIMIT, 100, "AI_DAILY_REQUEST_LIMIT");

const aiLimiter = createRateLimiter({
  rules: [
    {
      scope: "client",
      windowMs: 10 * MINUTE,
      max: 30,
      message: "Too many AI requests. Wait a few minutes and try again.",
    },
    {
      scope: "global",
      windowMs: MINUTE,
      max: AI_REQUESTS_PER_MINUTE,
      message: "The AI is busy with other requests. Try again in a minute.",
    },
    {
      scope: "global",
      windowMs: 24 * 60 * MINUTE,
      max: AI_DAILY_REQUEST_LIMIT,
      message: "The demo's AI request limit has been reached. Try again later.",
    },
  ],
});

// Each checkout creates a PayPal Sandbox order and a database row.
const createOrderLimiter = createRateLimiter({
  rules: [
    {
      scope: "client",
      windowMs: 10 * MINUTE,
      max: 20,
      message: "Too many checkout attempts. Wait a few minutes and try again.",
    },
    {
      scope: "global",
      windowMs: 60 * MINUTE,
      max: 100,
      message: "Too many checkouts are being started. Try again later.",
    },
  ],
});

// Capture and status checks are safe to repeat, so this limit is generous
// and only stops floods.
const paymentStatusLimiter = createRateLimiter({
  rules: [
    {
      scope: "client",
      windowMs: MINUTE,
      max: 60,
      message: "Too many payment status requests. Wait a moment and try again.",
    },
  ],
});

// These health checks are also cached (see below), so at most one call to
// PayPal or Gemini per minute comes from them; the limit stops floods.
const upstreamHealthLimiter = createRateLimiter({
  rules: [
    {
      scope: "client",
      windowMs: MINUTE,
      max: 10,
      message: "Too many health checks. Wait a moment and try again.",
    },
    {
      scope: "global",
      windowMs: MINUTE,
      max: 60,
      message: "Too many health checks. Wait a moment and try again.",
    },
  ],
});

// On SIGINT or SIGTERM: refuse new requests, let requests in progress finish
// (a PayPal capture can take up to about 50 seconds), then close the
// PostgreSQL pool. SHUTDOWN_GRACE_MS caps the wait; see gracefulShutdown.ts.
const shutdown = createGracefulShutdown({
  graceMs: readShutdownGraceMs(process.env.SHUTDOWN_GRACE_MS),
  closeResources: () => orderRegistry.close(),
});

app.use(securityHeaders);
// CORS is not authentication; see corsOptions in securityMiddleware.ts.
app.use(cors(corsOptions(CLIENT_ORIGINS)));
// After cors, so a browser can read the 503 sent while shutting down.
app.use(shutdown.middleware);
app.use(rejectDisallowedOrigins(CLIENT_ORIGINS));
app.use(requireJsonBody);
// keepRawWebhookBody keeps the exact bytes of PayPal webhook deliveries,
// which their signature covers; other bodies are only parsed.
app.use(express.json({ limit: "100kb", verify: keepRawWebhookBody }));

// One PostgreSQL pool for payments, accounts and subscriptions. It connects
// on first use; start() creates the schema before the server accepts any
// request.
const pool = createPostgresPool(DATABASE_URL);

// Accounts and sessions (auth.ts). authenticate only reads the session
// cookie; each protected route states what it requires.
const SESSION_COOKIE = readSessionCookieConfig(process.env);
const auth = createAuthModule({
  pool,
  allowedOrigins: CLIENT_ORIGINS,
  cookie: SESSION_COOKIE,
  trackHandler: shutdown.trackHandler,
});
app.use(auth.authenticate);
app.use(auth.router);

// PayPal Sandbox subscriptions (subscriptions.ts): USD 5.00 per month after
// a 7-day free trial. Without PAYPAL_SUBSCRIPTION_PLAN_ID nobody can
// subscribe; without PAYPAL_WEBHOOK_ID every webhook is refused (the state
// is then only updated by reading it from PayPal).
const subscriptions = createSubscriptionModule({
  pool,
  auth,
  payPal: { fetch, baseUrl: PAYPAL_BASE_URL, getAccessToken: getPayPalAccessToken },
  planId: process.env.PAYPAL_SUBSCRIPTION_PLAN_ID?.trim() || undefined,
  webhookId: process.env.PAYPAL_WEBHOOK_ID?.trim() || undefined,
  allowedOrigins: CLIENT_ORIGINS,
  trackHandler: shutdown.trackHandler,
});
app.use(subscriptions.router);
app.use(createAdminRouter({ pool, auth, trackHandler: shutdown.trackHandler }));

// Plans and monthly usage (usage.ts): Free gets 2 AI brief analyses a month,
// Pro (an ACTIVE subscription, trial included) 30, counted in PostgreSQL.
const usage = createUsageModule({ pool, auth, hasActiveSubscription: subscriptions.hasActiveSubscription });
app.use(usage.router);
// Saved client projects (projects.ts), each visible only to its owner.
app.use(
  createProjectRouter({ pool, auth, requireEntitlement: subscriptions.requireEntitlement, trackHandler: shutdown.trackHandler }),
);

// AI access, checked before the AI rate limits so refused requests don't use
// up the shared budget: brief analysis is on every plan within its monthly
// allowance; proposal drafting and the AI risk review need Pro (an ACTIVE
// subscription, the free trial included).
const canAnalyzeBriefs = [
  auth.requireUser,
  auth.requirePermission("proposal:create"),
  usage.analysisQuota,
];
const canCreateProposals = [
  auth.requireUser,
  auth.requirePermission("proposal:create"),
  subscriptions.requireEntitlement,
];
const canReviewProposals = [
  auth.requireUser,
  auth.requirePermission("proposal:review"),
  subscriptions.requireEntitlement,
];


async function getPayPalAccessToken(): Promise<string> {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("PayPal credentials are missing.");
  }

  const credentials = Buffer.from(
    `${clientId}:${clientSecret}`
  ).toString("base64");

  const response = await fetch(`${PAYPAL_BASE_URL}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(
      `PayPal authentication failed: HTTP ${response.status}`
    );
  }

  const data = (await response.json()) as {
    access_token?: string;
  };

  if (!data.access_token) {
    throw new Error("PayPal did not return an access token.");
  }

  return data.access_token;
}


const BriefSchema = z.object({
  brief: z.string().trim().min(20).max(5000),
});

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    application: "PayPilot AI",
    // Same AI_PROVIDER rule the proposal routes use; Ollama is the default.
    aiProvider: resolveProvider({}) === "gemini" ? "Gemini" : "Ollama",
  });
});

// Health results that need an outside service are cached for a minute.
const HEALTH_CACHE_MS = 60_000;

async function checkPayPalHealth(): Promise<HealthResult> {
  try {
    await getPayPalAccessToken();
    return {
      status: 200,
      body: { status: "ok", provider: "PayPal Sandbox", authenticated: true },
    };
  } catch (error) {
    console.error(
      "PayPal health check failed:",
      error instanceof Error ? error.message : "Unknown error"
    );
    return {
      status: 502,
      body: {
        status: "error",
        provider: "PayPal Sandbox",
        authenticated: false,
        message: "Authentication failed. Check the Sandbox app credentials.",
      },
    };
  }
}

const payPalHealth = createCachedCheck(checkPayPalHealth, { ttlMs: HEALTH_CACHE_MS });

app.get("/api/payments/health", upstreamHealthLimiter, shutdown.trackHandler(async (_req, res) => {
  const result = await payPalHealth();
  return res.status(result.status).json(result.body);
}));

// Uses the shared pool; closing the registry ends it.
const orderRegistry = new PostgresOrderRegistry(pool);

// POST /api/payments/create-order: the fixed USD 5.00 Sandbox test order
// (see checkoutRoute.ts). The amount and currency never come from the browser.
app.use("/api/payments/create-order", createOrderLimiter);
app.use(
  createCheckoutRouter({
    registry: orderRegistry,
    allowedOrigins: CLIENT_ORIGINS,
    getAccessToken: getPayPalAccessToken,
    fetch,
    baseUrl: PAYPAL_BASE_URL,
    trackHandler: shutdown.trackHandler,
  }),
);

// POST /api/payments/capture-order and GET /api/payments/orders/:id. Both
// need the order's checkout token; capture is verified against the amount
// and currency registered for the order.
app.use("/api/payments/capture-order", paymentStatusLimiter);
app.use("/api/payments/orders", paymentStatusLimiter);
app.use(
  createPaymentRouter(
    orderRegistry,
    async (orderID, expected) => {
      const accessToken = await getPayPalAccessToken();

      return capturePayPalOrder(orderID, expected, {
        fetch,
        baseUrl: PAYPAL_BASE_URL,
        accessToken,
      });
    },
    shutdown.trackHandler,
  ),
);


// Checks the Gemini key and model by looking the model up, which generates no
// content. The key is sent only in the request header; it is never returned
// or logged.
async function checkGeminiHealth(): Promise<HealthResult> {
  const provider = "Gemini";
  const model = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  const apiKey = process.env.GEMINI_API_KEY?.trim();

  if (!apiKey) {
    return {
      status: 503,
      body: {
        status: "error",
        provider,
        model,
        configured: false,
        message: "GEMINI_API_KEY is not set on the server.",
      },
    };
  }

  try {
    const response = await fetch(
      `${GEMINI_API_URL}/models/${encodeURIComponent(model)}`,
      {
        headers: { "x-goog-api-key": apiKey },
        signal: AbortSignal.timeout(10000),
      },
    );

    if (response.ok) {
      return { status: 200, body: { status: "ok", provider, model, configured: true } };
    }

    let message: string;
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      message = "The Gemini API rejected the API key. Check GEMINI_API_KEY.";
    } else if (response.status === 404) {
      message = `The Gemini model "${model}" was not found. Check GEMINI_MODEL.`;
    } else if (response.status === 429) {
      message = "The Gemini API rate limit or quota was reached. Try again later.";
    } else {
      message = `The Gemini API returned HTTP ${response.status}.`;
    }

    return {
      status: 502,
      body: { status: "error", provider, model, configured: true, message },
    };
  } catch {
    return {
      status: 503,
      body: {
        status: "error",
        provider,
        model,
        configured: true,
        message: "Cannot connect to the Gemini API.",
      },
    };
  }
}

async function checkOllamaHealth(): Promise<HealthResult> {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return { status: 502, body: { status: "error" } };
    }

    const data = (await response.json()) as { models?: unknown[] };
    return { status: 200, body: { status: "ok", models: data.models ?? [] } };
  } catch {
    return {
      status: 503,
      body: { status: "error", message: "Cannot connect to Ollama." },
    };
  }
}

const aiHealth = createCachedCheck(
  () => (resolveProvider({}) === "gemini" ? checkGeminiHealth() : checkOllamaHealth()),
  { ttlMs: HEALTH_CACHE_MS },
);

app.get("/api/ai/health", upstreamHealthLimiter, shutdown.trackHandler(async (_req, res) => {
  const result = await aiHealth();
  return res.status(result.status).json(result.body);
}));

app.post("/api/proposals/analyze", ...canAnalyzeBriefs, aiLimiter, shutdown.trackHandler(async (req, res) => {
  const parsed = BriefSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: "Provide a project brief between 20 and 5000 characters.",
    });
  }

  const result = await analyzeBrief(parsed.data.brief, {
    fetch,
    ollamaUrl: OLLAMA_URL,
    model: OLLAMA_MODEL,
  });

  if (!result.ok) {
    console.error("Proposal analysis failed:", {
      error: result.error,
      attempts: result.attempts,
    });
    return res.status(result.status).json({ error: result.error });
  }

  if (result.adjustedFields.length > 0 || result.attempts > 1) {
    // Field names only; never the brief or model text.
    console.warn("Proposal analysis adjusted:", {
      fields: result.adjustedFields,
      attempts: result.attempts,
    });
  }

  return res.json({ analysis: result.analysis });
}));

// Drafts a full proposal from a brief. Generating or editing a proposal never
// creates a PayPal order or charges anyone.
app.post("/api/proposals/draft", ...canCreateProposals, aiLimiter, shutdown.trackHandler(async (req, res) => {
  const parsed = BriefSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: "Provide a project brief between 20 and 5000 characters.",
    });
  }

  const result = await generateProposalDraft(parsed.data.brief, {
    fetch,
    ollamaUrl: OLLAMA_URL,
    model: OLLAMA_MODEL,
  });

  if (!result.ok) {
    console.error("Proposal drafting failed:", result.error);
    return res.status(result.status).json({ error: result.error });
  }

  return res.json({ proposal: result.draft });
}));

// AI part of the proposal risk review, using the configured AI provider.
// It never creates or captures PayPal orders.
app.post("/api/proposals/review", ...canReviewProposals, aiLimiter, shutdown.trackHandler(async (req, res) => {
  const parsed = ReviewRequestSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: "Provide the source brief (20 to 5000 characters) and a valid proposal.",
    });
  }

  const result = await reviewProposalWithAI(parsed.data, {
    fetch,
    ollamaUrl: OLLAMA_URL,
    model: OLLAMA_MODEL,
  });

  if (!result.ok) {
    console.error("Proposal risk review failed:", result.error);
    return res.status(result.status).json({ error: result.error });
  }

  if (result.discarded > 0) {
    console.warn("Proposal risk review discarded ungrounded findings:", result.discarded);
  }

  return res.json({ findings: result.findings });
}));

app.use(notFoundHandler);

// Must stay after every route: turns body-parsing and unexpected errors into
// JSON instead of Express's HTML page with a stack trace.
app.use(jsonErrorHandler);

async function start() {
  try {
    await orderRegistry.initialize();
    // Accounts and subscriptions (schema versions 3 and 4), then the
    // optional bootstrap admin.
    const migrated = await migrateAccountSchema(pool);
    if (migrated.length > 0) console.log("Applied account schema migrations:", migrated);
    await auth.bootstrapAdmin(process.env.BOOTSTRAP_ADMIN_EMAIL, process.env.BOOTSTRAP_ADMIN_PASSWORD);
  } catch (error) {
    console.error(
      "Could not initialize the PostgreSQL schema, so the server was not started:",
      error instanceof Error ? error.message : "Unknown error",
    );
    await orderRegistry.close().catch(() => undefined);
    process.exitCode = 1;
    return;
  }

  const server = app.listen(PORT, () => {
    console.log(`PayPilot API running at http://localhost:${PORT}`);
    console.log("PayPal order registry: PostgreSQL (DATABASE_URL).");
    // Effective settings, so a deployment can be checked from its logs. No
    // secrets: origins and limits only.
    console.log("Configuration:", {
      clientOrigins: CLIENT_ORIGINS,
      payPal: "Sandbox",
      aiProvider: resolveProvider({}),
      aiRequestsPerMinute: AI_REQUESTS_PER_MINUTE,
      aiDailyRequestLimit: AI_DAILY_REQUEST_LIMIT,
      trustProxy: app.get("trust proxy"),
      sessionCookie: {
        sameSite: SESSION_COOKIE.sameSite,
        secure: SESSION_COOKIE.secure,
        partitioned: SESSION_COOKIE.partitioned,
        ttlHours: SESSION_COOKIE.ttlMs / 3_600_000,
      },
      subscriptionPlanConfigured: Boolean(process.env.PAYPAL_SUBSCRIPTION_PLAN_ID?.trim()),
      payPalWebhooksConfigured: Boolean(process.env.PAYPAL_WEBHOOK_ID?.trim()),
    });
  });

  server.on("error", (error) => {
    console.error("The server could not start:", error.message);
    void orderRegistry.close().finally(() => process.exit(1));
  });

  shutdown.attach(server);
  process.on("SIGINT", () => shutdown.shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown.shutdown("SIGTERM"));
}

void start();
