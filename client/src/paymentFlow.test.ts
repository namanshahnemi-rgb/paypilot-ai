// Regression tests for the checkout UI's payment decisions: redirects,
// PayPal returns (including refreshes and cancelled or forged returns), and
// when a payment may be shown as completed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import {
  forgetCheckout,
  isConfirmedPayment,
  isPayPalApprovalUrl,
  isWellFormedCheckoutToken,
  readPaymentReturn,
  readSavedCheckout,
  saveCheckout,
} from "./paymentFlow.ts";

const ORDER = "5O190127TN364715T";

test("the browser is only sent to HTTPS PayPal checkout pages", () => {
  assert.ok(isPayPalApprovalUrl(`https://www.sandbox.paypal.com/checkoutnow?token=${ORDER}`));
  assert.ok(isPayPalApprovalUrl(`https://www.paypal.com/checkoutnow?token=${ORDER}`));
  for (const href of [
    "javascript:alert(document.cookie)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "http://www.sandbox.paypal.com/checkoutnow",
    "https://www.sandbox.paypal.com.evil.example/checkoutnow",
    "https://evilpaypal.com/",
    "https://user:pass@www.paypal.com/",
    "//www.paypal.com/checkoutnow",
    "/checkoutnow",
    "",
    undefined,
    null,
  ]) {
    assert.equal(isPayPalApprovalUrl(href), false, String(href));
  }
});

test("returning from PayPal with this tab's order captures that order", () => {
  assert.deepEqual(readPaymentReturn(`?payment=return&token=${ORDER}&PayerID=ABC`, ORDER), {
    kind: "capture",
    orderID: ORDER,
  });
});

test("a cancelled checkout never captures", () => {
  assert.deepEqual(readPaymentReturn(`?payment=cancel&token=${ORDER}`, ORDER), { kind: "cancelled" });
  assert.deepEqual(readPaymentReturn("?payment=cancel", null), { kind: "cancelled" });
});

test("a return for a different order, or without a started order, never captures", () => {
  // A crafted link with someone else's order ID.
  assert.deepEqual(readPaymentReturn("?payment=return&token=OTHERORDER123", ORDER), { kind: "mismatch" });
  // A return link opened in a new tab, which has no saved order.
  assert.deepEqual(readPaymentReturn(`?payment=return&token=${ORDER}`, null), { kind: "mismatch" });
  // No token at all.
  assert.deepEqual(readPaymentReturn("?payment=return", ORDER), { kind: "mismatch" });
});

test("a refresh (no return parameters) only reads the saved order's status", () => {
  assert.deepEqual(readPaymentReturn("", ORDER), { kind: "none", recoverOrderID: ORDER });
  assert.deepEqual(readPaymentReturn("", null), { kind: "none", recoverOrderID: null });
  assert.deepEqual(readPaymentReturn("?payment=paid", ORDER), { kind: "none", recoverOrderID: ORDER });
});

test("only a verified, completed capture is shown as a successful payment", () => {
  const paid = {
    paymentStatus: "PAID",
    paid: true,
    captureStatus: "COMPLETED",
    amount: "5.00",
    currency: "USD",
  };
  assert.equal(isConfirmedPayment(paid), true);

  for (const notPaid of [
    { ...paid, paymentStatus: "PENDING" },
    { ...paid, paymentStatus: "NEEDS_REVIEW" },
    { ...paid, paid: false },
    { ...paid, captureStatus: "PENDING" },
    { ...paid, captureStatus: null },
    { ...paid, amount: null },
    { ...paid, currency: "" },
    { paid: true },
    {},
  ]) {
    assert.equal(isConfirmedPayment(notPaid), false, JSON.stringify(notPaid));
  }
});

test("components never render HTML from strings, so AI or API text can't inject markup", () => {
  const dir = new URL(".", import.meta.url);
  const sources = readdirSync(dir).filter((name) => /\.tsx?$/.test(name) && !name.endsWith(".test.ts"));
  assert.ok(sources.includes("App.tsx"));
  for (const name of sources) {
    const source = readFileSync(new URL(name, dir), "utf8");
    assert.doesNotMatch(source, /dangerouslySetInnerHTML|\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write|\beval\(|new Function\(/, name);
  }
});

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

const TOKEN = "A".repeat(20) + "b_-" + "9".repeat(20);

test("the checkout token format matches the server's 256-bit base64url tokens", () => {
  assert.equal(TOKEN.length, 43);
  assert.ok(isWellFormedCheckoutToken(TOKEN));
  for (const bad of ["", "short", TOKEN + "x", TOKEN.slice(0, 42) + "!", null, undefined, 42]) {
    assert.equal(isWellFormedCheckoutToken(bad), false, String(bad));
  }
});

test("a saved checkout needs both the order ID and a well-formed token", () => {
  const storage = memoryStorage();
  assert.equal(readSavedCheckout(storage), null);

  saveCheckout(storage, { orderID: ORDER, checkoutToken: TOKEN });
  assert.deepEqual(readSavedCheckout(storage), { orderID: ORDER, checkoutToken: TOKEN });

  // A tab from before checkout tokens existed has only the order ID.
  assert.equal(readSavedCheckout(memoryStorage({ paypilot_order_id: ORDER })), null);
  assert.equal(readSavedCheckout(memoryStorage({ paypilot_order_id: ORDER, paypilot_checkout_token: "tampered" })), null);
  assert.equal(readSavedCheckout(memoryStorage({ paypilot_order_id: "<script>", paypilot_checkout_token: TOKEN })), null);
});

test("forgetting a checkout removes the order ID and its token", () => {
  const storage = memoryStorage();
  saveCheckout(storage, { orderID: ORDER, checkoutToken: TOKEN });
  forgetCheckout(storage);
  assert.equal(storage.items.size, 0);
  assert.equal(readSavedCheckout(storage), null);
});

test("unavailable storage is treated as no saved checkout", () => {
  const broken = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("SecurityError");
    },
    removeItem: () => {
      throw new Error("SecurityError");
    },
  };
  assert.equal(readSavedCheckout(broken), null);
  assert.doesNotThrow(() => forgetCheckout(broken));
});

test("the checkout token is never put in a URL by the app", () => {
  const app = readFileSync(new URL("App.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(app, /[?&]checkoutToken=|checkoutToken=\$\{/, "no token query parameter");
  assert.match(app, /CHECKOUT_TOKEN_HEADER/, "status lookups send it in a header");
});
