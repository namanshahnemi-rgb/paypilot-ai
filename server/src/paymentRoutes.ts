// POST /api/payments/capture-order and GET /api/payments/orders/:id.
//
// Both require the order's checkout token (see checkoutToken.ts): the order
// ID alone is not secret, so without the token anyone who saw it could read
// the order or trigger its capture. A wrong token gets the same 404 as an
// unknown order, so the API never confirms that an order ID exists.
import express from "express";
import type { CaptureResult, ExpectedAmount } from "./paypalCapture.js";
import {
  isValidOrderID,
  toOrderView,
  type OrderRegistryPort,
} from "./orderModel.js";
import {
  CHECKOUT_TOKEN_HEADER,
  checkoutTokenMatches,
  isWellFormedCheckoutToken,
} from "./checkoutToken.js";
import type { HandlerTracker } from "./gracefulShutdown.js";

export type RunCapture = (
  orderID: string,
  expected: ExpectedAmount,
) => Promise<CaptureResult>;

const INVALID_ID = { error: "A valid PayPal order ID is required." };

const MISSING_TOKEN = {
  error:
    "This checkout can only be checked from the browser tab that started it. Start a new checkout.",
};

const UNKNOWN_ORDER = {
  error:
    "This order is not known to the server. It may have been created by a different PayPilot server or database. Start a new checkout or check the PayPal Sandbox dashboard.",
};

const untracked: HandlerTracker = (handler) => handler;

// Works with any registry: PostgreSQL in the app, SQLite in the unit tests.
// `trackHandler` lets graceful shutdown wait for a capture that is still
// running after its client disconnected.
export function createPaymentRouter(
  registry: OrderRegistryPort,
  runCapture: RunCapture,
  trackHandler: HandlerTracker = untracked,
) {
  const router = express.Router();

  // True when the order exists and `token` is the one issued for it. The
  // token hash never changes after registration, so checking it before the
  // capture can't race with another request.
  async function ownsOrder(orderID: string, token: string): Promise<boolean> {
    const record = await registry.get(orderID);
    return Boolean(record && checkoutTokenMatches(record.checkoutTokenHash, token));
  }

  router.post("/api/payments/capture-order", trackHandler(async (req, res) => {
    const orderID: unknown = req.body?.orderID;
    const checkoutToken: unknown = req.body?.checkoutToken;

    if (!isValidOrderID(orderID)) {
      return res.status(400).json(INVALID_ID);
    }
    if (!isWellFormedCheckoutToken(checkoutToken)) {
      return res.status(400).json(MISSING_TOKEN);
    }

    try {
      if (!(await ownsOrder(orderID, checkoutToken))) {
        return res.status(404).json(UNKNOWN_ORDER);
      }

      const record = await registry.capture(orderID, (expected) =>
        runCapture(orderID, expected),
      );

      if (!record) {
        return res.status(404).json(UNKNOWN_ORDER);
      }

      return res.json(toOrderView(record));
    } catch (error) {
      console.error(
        "Capture order failed:",
        error instanceof Error ? error.message : "Unknown error",
      );

      return res.status(502).json({
        error: "Could not capture PayPal payment.",
      });
    }
  }));

  router.get("/api/payments/orders/:id", trackHandler(async (req, res) => {
    const orderID = req.params.id;
    const checkoutToken = req.get(CHECKOUT_TOKEN_HEADER);

    if (!isValidOrderID(orderID)) {
      return res.status(400).json(INVALID_ID);
    }
    if (!isWellFormedCheckoutToken(checkoutToken)) {
      return res.status(400).json(MISSING_TOKEN);
    }

    try {
      const record = await registry.get(orderID);

      if (!record || !checkoutTokenMatches(record.checkoutTokenHash, checkoutToken)) {
        return res.status(404).json(UNKNOWN_ORDER);
      }

      return res.json(toOrderView(record));
    } catch (error) {
      console.error(
        "Order status lookup failed:",
        error instanceof Error ? error.message : "Unknown error",
      );

      return res.status(500).json({
        error: "Could not retrieve payment status.",
      });
    }
  }));

  return router;
}
