// Payment decisions the checkout UI makes, kept free of React so they can be
// tested: where the browser may be sent, what to do when PayPal sends the
// buyer back, and when a payment may be shown as completed.

// The browser is only ever sent to an HTTPS PayPal checkout page. Anything
// else from the backend, such as a javascript: URL or another site, is
// refused, so a misconfigured or compromised API URL can't redirect users.
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

export type PaymentReturnAction =
  // PayPal checkout was cancelled: forget the order; nothing was paid.
  | { kind: "cancelled" }
  // Not a PayPal return. After a refresh, show the saved order's status by
  // reading it only (never capturing).
  | { kind: "none"; recoverOrderID: string | null }
  // A return whose order doesn't match the one this tab started: don't
  // capture anything.
  | { kind: "mismatch" }
  // The buyer approved the order this tab started: capture it.
  | { kind: "capture"; orderID: string };

// Decides what to do with the page's query string when it loads.
// `savedOrderID` is the order this tab started (sessionStorage).
export function readPaymentReturn(
  search: string,
  savedOrderID: string | null,
): PaymentReturnAction {
  const params = new URLSearchParams(search);
  const payment = params.get("payment");

  if (payment === "cancel") return { kind: "cancelled" };
  if (payment !== "return") return { kind: "none", recoverOrderID: savedOrderID };

  const returnedToken = params.get("token");
  if (!savedOrderID || !returnedToken || returnedToken !== savedOrderID) {
    return { kind: "mismatch" };
  }
  return { kind: "capture", orderID: savedOrderID };
}

export type PaymentStatusView = {
  paymentStatus?: string;
  paid?: boolean;
  captureStatus?: string | null;
  amount?: string | null;
  currency?: string | null;
};

// Success is shown only when the backend reports a verified, completed
// capture with an amount and currency; anything less is not a payment.
export function isConfirmedPayment(data: PaymentStatusView): boolean {
  return Boolean(
    data.paymentStatus === "PAID" &&
      data.paid === true &&
      data.captureStatus === "COMPLETED" &&
      data.amount &&
      data.currency,
  );
}

// The checkout this tab started: the PayPal order ID and the checkout token
// the server issued for it. The token proves to the server that this tab
// created the order; it is kept only in this tab's sessionStorage, is never
// put in a URL, and grants nothing beyond this one Sandbox test order.
export const ORDER_STORAGE_KEY = "paypilot_order_id";
export const CHECKOUT_TOKEN_STORAGE_KEY = "paypilot_checkout_token";
export const CHECKOUT_TOKEN_HEADER = "X-Checkout-Token";

export function isWellFormedCheckoutToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export type SavedCheckout = { orderID: string; checkoutToken: string };

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

// The saved checkout, or null when either part is missing or malformed (for
// example, a tab from before checkout tokens existed).
export function readSavedCheckout(storage: StorageLike): SavedCheckout | null {
  try {
    const orderID = storage.getItem(ORDER_STORAGE_KEY);
    const checkoutToken = storage.getItem(CHECKOUT_TOKEN_STORAGE_KEY);
    if (!orderID || !/^[A-Z0-9-]{1,100}$/i.test(orderID)) return null;
    if (!isWellFormedCheckoutToken(checkoutToken)) return null;
    return { orderID, checkoutToken };
  } catch {
    return null;
  }
}

export function saveCheckout(storage: StorageLike, checkout: SavedCheckout): void {
  storage.setItem(ORDER_STORAGE_KEY, checkout.orderID);
  storage.setItem(CHECKOUT_TOKEN_STORAGE_KEY, checkout.checkoutToken);
}

export function forgetCheckout(storage: StorageLike): void {
  try {
    storage.removeItem(ORDER_STORAGE_KEY);
    storage.removeItem(CHECKOUT_TOKEN_STORAGE_KEY);
  } catch {
    // Storage unavailable: nothing was saved.
  }
}
