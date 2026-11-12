// In-memory request limits for the public endpoints. The API has no user
// accounts, so without limits anyone could use up the Gemini free-tier quota,
// create unlimited PayPal Sandbox orders and database rows, or make the
// server call PayPal's token endpoint in a loop through the health check.
//
// Limits are kept per process. That fits the single Render instance; with
// several instances each one enforces its own limits.
import type { Request, RequestHandler } from "express";

export type RateLimitRule = {
  // "client" counts each client address separately; "global" counts every
  // request to the endpoints this limiter guards, whoever sends it.
  scope: "client" | "global";
  windowMs: number;
  max: number;
  message: string;
};

export type RateLimiterOptions = {
  rules: RateLimitRule[];
  now?: () => number;
  // Caps memory use when many different addresses send requests. Past the
  // cap, unknown addresses share one counter instead of adding entries.
  maxTrackedClients?: number;
};

type Window = { count: number; resetAt: number };

const OVERFLOW_KEY = "\0overflow";

// The address Express reports for the request. Behind a proxy this is the
// proxy's address unless "trust proxy" is configured (see TRUST_PROXY), in
// which case every client shares the "client" limits: stricter, never looser.
function clientKey(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

export function createRateLimiter(options: RateLimiterOptions): RequestHandler {
  const now = options.now ?? Date.now;
  const maxTrackedClients = options.maxTrackedClients ?? 10_000;
  const windows = options.rules.map(() => new Map<string, Window>());

  function counterKey(rule: RateLimitRule, store: Map<string, Window>, req: Request, time: number) {
    if (rule.scope === "global") return "global";
    const key = clientKey(req);
    if (store.has(key) || store.size < maxTrackedClients) return key;
    for (const [stored, window] of store) {
      if (window.resetAt <= time) store.delete(stored);
    }
    return store.size < maxTrackedClients ? key : OVERFLOW_KEY;
  }

  return (req, res, next) => {
    const time = now();
    const counters = options.rules.map((rule, index) => {
      const store = windows[index]!;
      const key = counterKey(rule, store, req, time);
      let window = store.get(key);
      if (!window || window.resetAt <= time) {
        window = { count: 0, resetAt: time + rule.windowMs };
        store.set(key, window);
      }
      return { rule, window };
    });

    // A request refused by one rule uses up none of the others, so a client
    // over its own limit can't drain the global budget.
    const blocked = counters.find(({ rule, window }) => window.count >= rule.max);
    if (blocked) {
      const retryAfter = Math.max(1, Math.ceil((blocked.window.resetAt - time) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({ error: blocked.rule.message });
      return;
    }

    for (const { window } of counters) window.count++;
    next();
  };
}

// Reads a whole-number limit from the environment, keeping the default for a
// missing or invalid value.
export function readLimit(
  value: string | undefined,
  fallback: number,
  name: string,
  logger: { error: (...args: unknown[]) => void } = console,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 1) return parsed;
  logger.error(`${name} must be a whole number of at least 1; using ${fallback}.`);
  return fallback;
}

// Reads TRUST_PROXY: the number of proxies in front of the server whose
// X-Forwarded-For entries Express may trust to find the client address.
// Unset or invalid means false: the socket address is used and the header
// is ignored, so it can't be forged to get a fresh limit.
export function readTrustProxy(
  value: string | undefined,
  logger: { error: (...args: unknown[]) => void } = console,
): number | false {
  if (value === undefined || value.trim() === "") return false;
  const hops = Number(value);
  if (Number.isInteger(hops) && hops >= 1 && hops <= 10) return hops;
  logger.error("TRUST_PROXY must be a whole number of proxies from 1 to 10; ignoring it.");
  return false;
}
