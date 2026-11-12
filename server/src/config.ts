// Validation of security-relevant environment settings. Each reader logs a
// clear message (never a secret value) and falls back to the safe choice.
type Logger = { error: (...args: unknown[]) => void };

export const DEFAULT_CLIENT_ORIGINS = "http://localhost:5173,http://localhost:5174";

// CLIENT_ORIGINS: comma-separated browser origins allowed to use the API,
// such as https://app.example.com. Each entry must be an exact origin
// (scheme, host, and optional port; no path or trailing slash), because the
// Origin header is compared exactly. Invalid entries are dropped, never
// widened: an empty result allows no browser origin at all.
export function parseClientOrigins(
  value: string | undefined,
  logger: Logger = console,
): string[] {
  const entries = (value ?? DEFAULT_CLIENT_ORIGINS)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  const origins: string[] = [];
  for (const entry of entries) {
    let origin: string | undefined;
    try {
      const url = new URL(entry);
      if (url.protocol === "https:" || url.protocol === "http:") origin = url.origin;
    } catch {
      origin = undefined;
    }
    if (origin !== entry) {
      logger.error(
        `CLIENT_ORIGINS entry "${entry.slice(0, 100)}" is not an exact origin such as https://app.example.com (no path, no trailing slash, no "*"); it was ignored.`,
      );
      continue;
    }
    if (!origins.includes(origin)) origins.push(origin);
  }

  if (origins.length === 0) {
    logger.error("CLIENT_ORIGINS has no valid origins, so no browser frontend can use the API.");
  }
  return origins;
}

// This project only ever uses PayPal Sandbox. Any other PAYPAL_BASE_URL,
// such as the live API, is refused, so a configuration mistake can't move
// real money.
export const PAYPAL_SANDBOX_URL = "https://api-m.sandbox.paypal.com";
const SANDBOX_HOSTS = new Set(["api-m.sandbox.paypal.com", "api.sandbox.paypal.com"]);

export function readPayPalBaseUrl(value: string | undefined): string {
  const configured = value?.trim();
  if (!configured) return PAYPAL_SANDBOX_URL;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error("PAYPAL_BASE_URL is not a valid URL. Use https://api-m.sandbox.paypal.com.");
  }
  if (url.protocol !== "https:" || !SANDBOX_HOSTS.has(url.hostname) || url.pathname !== "/") {
    throw new Error(
      "PAYPAL_BASE_URL must be the PayPal Sandbox API (https://api-m.sandbox.paypal.com). PayPilot AI never uses live PayPal.",
    );
  }
  return url.origin;
}
