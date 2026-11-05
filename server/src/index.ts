
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { z } from "zod";
import {
  capturePayPalOrder,
  summarizePayPalError,
  type PayPalErrorBody,
} from "./paypalCapture.js";
import { OrderRegistry } from "./orderRegistry.js";
import { createPaymentRouter } from "./paymentRoutes.js";
import { generateProposalDraft } from "./proposalGenerator.js";
import { analyzeBrief } from "./analysis.js";
import { ReviewRequestSchema, reviewProposalWithAI } from "./riskReview.js";
import { jsonErrorHandler } from "./httpErrors.js";
import { DEFAULT_GEMINI_MODEL, resolveProvider } from "./localModel.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 4000;
const OLLAMA_URL = "http://localhost:11434";
const OLLAMA_MODEL = "qwen2.5:3b";
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta";


// Comma-separated list of allowed frontend origins. Vite uses 5173 by default
// and falls back to 5174 when 5173 is already taken.
const CLIENT_ORIGINS = (
  process.env.CLIENT_ORIGINS ?? "http://localhost:5173,http://localhost:5174"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const DEFAULT_CLIENT_ORIGIN = CLIENT_ORIGINS[0] ?? "http://localhost:5173";

// Send PayPal back to the same allowed origin that started checkout, because
// the pending order ID lives in that origin's sessionStorage.
function getClientOrigin(req: express.Request): string {
  const origin = req.get("origin");
  return origin && CLIENT_ORIGINS.includes(origin)
    ? origin
    : DEFAULT_CLIENT_ORIGIN;
}

app.use(cors({ origin: CLIENT_ORIGINS }));
app.use(express.json({ limit: "100kb" }));


async function getPayPalAccessToken(): Promise<string> {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const baseUrl =
    process.env.PAYPAL_BASE_URL ??
    "https://api-m.sandbox.paypal.com";

  if (!clientId || !clientSecret) {
    throw new Error("PayPal credentials are missing.");
  }

  const credentials = Buffer.from(
    `${clientId}:${clientSecret}`
  ).toString("base64");

  const response = await fetch(`${baseUrl}/v1/oauth2/token`, {
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

app.get("/api/payments/health", async (_req, res) => {
  try {
    await getPayPalAccessToken();

    return res.json({
      status: "ok",
      provider: "PayPal Sandbox",
      authenticated: true,
    });
  } catch (error) {
    console.error(
      "PayPal health check failed:",
      error instanceof Error ? error.message : "Unknown error"
    );

    return res.status(502).json({
      status: "error",
      provider: "PayPal Sandbox",
      authenticated: false,
      message:
        "Authentication failed. Check the Sandbox app credentials.",
    });
  }
});


  
const TEST_PAYMENT_AMOUNT = "5.00";
const PAYMENT_CURRENCY = "USD";

const SERVER_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const PAYMENT_DB_PATH = process.env.PAYMENT_DB_PATH?.trim()
  ? path.resolve(process.env.PAYMENT_DB_PATH)
  : path.join(SERVER_DIR, "data", "paypilot.db");

const orderRegistry = new OrderRegistry({
  filename: PAYMENT_DB_PATH,
});

app.post("/api/payments/create-order", async (req, res) => {
  const clientOrigin = getClientOrigin(req);

  try {
    const accessToken = await getPayPalAccessToken();
    const baseUrl =
      process.env.PAYPAL_BASE_URL ??
      "https://api-m.sandbox.paypal.com";

    const response = await fetch(`${baseUrl}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "PayPal-Request-Id": crypto.randomUUID(),
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        application_context: {
          return_url: `${clientOrigin}/?payment=return`,
          cancel_url: `${clientOrigin}/?payment=cancel`,
          user_action: "PAY_NOW",
        },
        purchase_units: [
          {
            amount: {
              currency_code: PAYMENT_CURRENCY,
              value: TEST_PAYMENT_AMOUNT,
            },
            description: "PayPilot AI Sandbox test payment",
          },
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });

    const data = (await response.json()) as PayPalErrorBody & {
      id?: string;
      status?: string;
      links?: Array<{ rel: string; href: string }>;
    };

    if (!response.ok || !data.id) {
      console.error("PayPal order creation failed:", {
        requestedCurrency: PAYMENT_CURRENCY,
        requestedAmount: TEST_PAYMENT_AMOUNT,
        ...summarizePayPalError(response, data),
      });
      return res.status(502).json({
        error: "Could not create PayPal order.",
      });
    }

    const approveUrl = data.links?.find(
      (link) => link.rel === "approve",
    )?.href;

    if (!approveUrl) {
      console.error("PayPal did not return an approval URL.");
      return res.status(502).json({
        error: "PayPal did not provide an approval URL.",
      });
    }

    orderRegistry.register(data.id, {
      value: TEST_PAYMENT_AMOUNT,
      currency: PAYMENT_CURRENCY,
    });

    console.log("PayPal order created:", {
      orderID: data.id,
      status: data.status,
      requestedCurrency: PAYMENT_CURRENCY,
      requestedAmount: TEST_PAYMENT_AMOUNT,
      returnOrigin: clientOrigin,
      debugId: response.headers.get("paypal-debug-id"),
    });

    return res.json({
      orderID: data.id,
      amount: TEST_PAYMENT_AMOUNT,
      currency: PAYMENT_CURRENCY,
      approveUrl,
    });
  } catch (error) {
    console.error(
      "Create order failed:",
      error instanceof Error ? error.message : "Unknown error",
    );

    return res.status(502).json({
      error: "Could not create PayPal order.",
    });
  }
});


// POST /api/payments/capture-order and GET /api/payments/orders/:id.
// Capture is verified against the amount and currency registered for the order.
app.use(
  createPaymentRouter(orderRegistry, async (orderID, expected) => {
    const accessToken = await getPayPalAccessToken();
    const baseUrl =
      process.env.PAYPAL_BASE_URL ??
      "https://api-m.sandbox.paypal.com";

    return capturePayPalOrder(orderID, expected, {
      fetch,
      baseUrl,
      accessToken,
    });
  }),
);


// Checks the Gemini key and model by looking the model up, which generates no
// content. The key is sent only in the request header; it is never returned
// or logged.
async function checkGeminiHealth(res: express.Response) {
  const provider = "Gemini";
  const model = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  const apiKey = process.env.GEMINI_API_KEY?.trim();

  if (!apiKey) {
    return res.status(503).json({
      status: "error",
      provider,
      model,
      configured: false,
      message: "GEMINI_API_KEY is not set on the server.",
    });
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
      return res.json({ status: "ok", provider, model, configured: true });
    }

    const message =
      response.status === 400 || response.status === 401 || response.status === 403
        ? "The Gemini API rejected the API key. Check GEMINI_API_KEY."
        : response.status === 404
          ? `The Gemini model "${model}" was not found. Check GEMINI_MODEL.`
          : response.status === 429
            ? "The Gemini API rate limit or quota was reached. Try again later."
            : `The Gemini API returned HTTP ${response.status}.`;

    return res.status(502).json({
      status: "error",
      provider,
      model,
      configured: true,
      message,
    });
  } catch {
    return res.status(503).json({
      status: "error",
      provider,
      model,
      configured: true,
      message: "Cannot connect to the Gemini API.",
    });
  }
}

app.get("/api/ai/health", async (_req, res) => {
  if (resolveProvider({}) === "gemini") {
    return checkGeminiHealth(res);
  }

  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`);

    if (!response.ok) {
      return res.status(502).json({ status: "error" });
    }

    const data = await response.json();
    return res.json({ status: "ok", models: data.models ?? [] });
  } catch {
    return res.status(503).json({
      status: "error",
      message: "Cannot connect to Ollama.",
    });
  }
});

app.post("/api/proposals/analyze", async (req, res) => {
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
});

// Drafts a full proposal from a brief. Generating or editing a proposal never
// creates a PayPal order or charges anyone.
app.post("/api/proposals/draft", async (req, res) => {
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
});

// AI part of the proposal risk review, using the configured AI provider.
// It never creates or captures PayPal orders.
app.post("/api/proposals/review", async (req, res) => {
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
});

// Must stay after every route: turns body-parsing and unexpected errors into
// JSON instead of Express's HTML page with a stack trace.
app.use(jsonErrorHandler);

app.listen(PORT, () => {
  console.log(`PayPilot API running at http://localhost:${PORT}`);
  console.log(
    "PayPal order registry: SQLite persistence enabled.",
  );
});
