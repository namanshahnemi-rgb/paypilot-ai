// Payment capture and status routes for orders in the registry. The PayPal
// call is injected so the routes can be tested with mocked PayPal responses.
import express from "express";
import type { CaptureResult, ExpectedAmount } from "./paypalCapture.js";
import { isValidOrderID, toOrderView, type OrderRegistry } from "./orderRegistry.js";

export type RunCapture = (
  orderID: string,
  expected: ExpectedAmount,
) => Promise<CaptureResult>;

const INVALID_ID = { error: "A valid PayPal order ID is required." };
const UNKNOWN_ORDER = {
  error:
    "This order is not known to the server. It may have been created before the backend restarted. Start a new checkout or check the PayPal Sandbox dashboard.",
};

export function createPaymentRouter(
  registry: OrderRegistry,
  runCapture: RunCapture,
) {
  const router = express.Router();

  // Only orders registered by this backend can be captured. Repeat requests
  // are safe: settled orders are answered from the registry, and PayPal
  // retries reuse a stable PayPal-Request-Id.
  router.post("/api/payments/capture-order", async (req, res) => {
    const orderID: unknown = req.body?.orderID;

    if (!isValidOrderID(orderID)) {
      return res.status(400).json(INVALID_ID);
    }

    try {
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
  });

  // Known status of a registered order. Reads the registry only; it never
  // contacts PayPal or captures anything.
  router.get("/api/payments/orders/:id", (req, res) => {
    const orderID = req.params.id;

    if (!isValidOrderID(orderID)) {
      return res.status(400).json(INVALID_ID);
    }

    const record = registry.get(orderID);

    if (!record) {
      return res.status(404).json(UNKNOWN_ORDER);
    }

    return res.json(toOrderView(record));
  });

  return router;
}
