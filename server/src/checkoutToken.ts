// Checkout tokens bind a PayPal order to the browser tab that created it.
//
// The API has no user accounts, and a PayPal order ID is not a secret: it is
// the `token` in the PayPal checkout URL and the return URL, so it can leak
// through browser history, screenshots, or shared links. When an order is
// created, the server makes a random 256-bit token, returns it once to that
// browser, and stores only its SHA-256 hash. Capturing the order or reading
// its status requires the token, so knowing an order ID is not enough.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// Request header carrying the token for GET /api/payments/orders/:id.
export const CHECKOUT_TOKEN_HEADER = "X-Checkout-Token";

// 32 random bytes in base64url: 43 characters.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

export function createCheckoutToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashCheckoutToken(token) };
}

export function hashCheckoutToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function isWellFormedCheckoutToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

// True only when `token` is the one issued for this order. Orders without a
// stored hash (created before tokens existed) never match. The comparison
// takes the same time wherever the hashes differ.
export function checkoutTokenMatches(
  storedHash: string | null,
  token: string,
): boolean {
  if (!storedHash || !HASH_PATTERN.test(storedHash) || !isWellFormedCheckoutToken(token)) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(storedHash, "hex"),
    Buffer.from(hashCheckoutToken(token), "hex"),
  );
}
