// POST /api/payments/create-order: creates the fixed Sandbox test order.
// Kept out of index.ts so it can be tested with a fake fetch, without
// credentials or real PayPal orders.
//
// The browser chooses nothing about the payment: the amount, currency, and
// return address all come from the server, and the request body is ignored.
import express from "express";
import { randomUUID } from "node:crypto";
import { summarizePayPalError, type PayPalErrorBody } from "./paypalCapture.js";
import type { OrderRegistryPort } from "./orderModel.js";
import { createCheckoutToken } from "./checkoutToken.js";
import type { HandlerTracker } from "./gracefulShutdown.js";

// The fixed PayPal Sandbox test payment. Not a client invoice.
export const TEST_PAYMENT_AMOUNT = "5.00";
export const PAYMENT_CURRENCY = "USD";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
type Logger = {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export type CheckoutDeps = {
  registry: OrderRegistryPort;
  // CLIENT_ORIGINS; the first entry is used when the request's origin isn't
  // in the list.
  allowedOrigins: string[];
  getAccessToken: () => Promise<string>;
  fetch: FetchLike;
  baseUrl: string;
  trackHandler?: HandlerTracker;
  logger?: Logger;
  timeoutMs?: number;
};

// PayPal sends the buyer back to the same allowed origin that started
// checkout, because the pending order ID lives in that origin's
// sessionStorage. Any other Origin header, forged or not, gets the default,
// so the return address is never chosen by the caller.
export function resolveReturnOrigin(
  origin: string | undefined,
  allowedOrigins: string[],
): string {
  const fallback = allowedOrigins[0] ?? "http://localhost:5173";
  return origin && allowedOrigins.includes(origin) ? origin : fallback;
}

// The browser is sent to this URL, so it must be an HTTPS PayPal address
// (www.paypal.com or www.sandbox.paypal.com) and nothing else, such as a
// javascript: URL or another site, even if PayPal's response were altered.
export function isPayPalApprovalUrl(href: unknown): href is string {
  if (typeof href !== "string") return false;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.port &&
    (url.hostname === "paypal.com" || url.hostname.endsWith(".paypal.com"))
  );
}

const untracked: HandlerTracker = (handler) => handler;

export function createCheckoutRouter(deps: CheckoutDeps) {
  const router = express.Router();
  const logger = deps.logger ?? console;
  const trackHandler = deps.trackHandler ?? untracked;
  const timeoutMs = deps.timeoutMs ?? 15000;

  router.post("/api/payments/create-order", trackHandler(async (req, res) => {
    const clientOrigin = resolveReturnOrigin(req.get("origin"), deps.allowedOrigins);

    try {
      const accessToken = await deps.getAccessToken();

      const response = await deps.fetch(`${deps.baseUrl}/v2/checkout/orders`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          // A new ID per checkout: each click is meant to be a new order,
          // and the server never retries this request itself. No money
          // moves until a capture, which has its own stable ID.
          "PayPal-Request-Id": randomUUID(),
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
        signal: AbortSignal.timeout(timeoutMs),
      });

      const data = (await response.json()) as PayPalErrorBody & {
        id?: string;
        status?: string;
        links?: Array<{ rel: string; href: string }>;
      };

      if (!response.ok || !data.id) {
        logger.error("PayPal order creation failed:", {
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

      if (!isPayPalApprovalUrl(approveUrl)) {
        logger.error("PayPal did not return a valid approval URL:", {
          orderID: data.id,
          present: approveUrl !== undefined,
        });
        return res.status(502).json({
          error: "PayPal did not provide an approval URL.",
        });
      }

      // Registered before the approval URL is returned: an order the server
      // can't verify later is never sent to checkout. Only the hash of the
      // checkout token is stored; the token itself goes to this browser once
      // and is never logged.
      const checkout = createCheckoutToken();
      await deps.registry.register(
        data.id,
        { value: TEST_PAYMENT_AMOUNT, currency: PAYMENT_CURRENCY },
        checkout.hash,
      );

      logger.log("PayPal order created:", {
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
        // Required to capture this order or read its status.
        checkoutToken: checkout.token,
      });
    } catch (error) {
      logger.error(
        "Create order failed:",
        error instanceof Error ? error.message : "Unknown error",
      );

      return res.status(502).json({
        error: "Could not create PayPal order.",
      });
    }
  }));

  return router;
}
