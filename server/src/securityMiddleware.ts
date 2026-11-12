// Request hardening shared by every route: response security headers,
// rejection of browser requests from origins outside CLIENT_ORIGINS,
// JSON-only request bodies, and a JSON 404 for unknown routes.
import type { RequestHandler } from "express";
import type { CorsOptions } from "cors";
import { CHECKOUT_TOKEN_HEADER } from "./checkoutToken.js";

// CORS lets the listed frontends read responses. It is not authentication:
// rejectDisallowedOrigins refuses other browser origins, the rate limits
// cover clients without an Origin header, orders need their checkout token,
// and accounts need a session. Only the methods and headers the frontend
// uses are allowed.
//
// Credentials (the session cookie) are allowed so the frontend, on another
// origin, can stay signed in. They are only ever granted together with one
// exact origin from CLIENT_ORIGINS, never "*", and cookie-authenticated
// writes must also carry an allowed Origin header (see auth.ts).
export function corsOptions(allowedOrigins: string[]): CorsOptions {
  return {
    origin: allowedOrigins,
    // PUT and PATCH save and update projects (projects.ts). DELETE is not used.
    methods: ["GET", "POST", "PUT", "PATCH"],
    allowedHeaders: ["Content-Type", CHECKOUT_TOKEN_HEADER],
    credentials: true,
    maxAge: 600,
  };
}

// The API only returns JSON, so it can deny every content type, framing, and
// caching. Strict-Transport-Security is ignored by browsers over plain HTTP,
// so it is harmless during local development.
export const securityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Strict-Transport-Security", "max-age=15552000");
  res.setHeader("Cache-Control", "no-store");
  next();
};

export const FORBIDDEN_ORIGIN_ERROR = "This origin is not allowed to use the PayPilot API.";

// CORS alone only stops a browser from reading the response; the request
// itself still runs. A browser always sends Origin on cross-site requests,
// so one from an origin outside the list is refused before any work starts.
// Requests without Origin (curl, server-to-server) are not browser
// cross-site requests and are left to the rate limits.
export function rejectDisallowedOrigins(allowedOrigins: string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);
  return (req, res, next) => {
    const origin = req.get("origin");
    if (origin !== undefined && !allowed.has(origin)) {
      res.status(403).json({ error: FORBIDDEN_ORIGIN_ERROR });
      return;
    }
    next();
  };
}

export const JSON_REQUIRED_ERROR =
  "Send the request body as JSON with Content-Type: application/json.";

const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Every write route takes JSON. Requiring the JSON content type means a
// browser can only send these requests after a CORS preflight, which
// CLIENT_ORIGINS controls; a form or text/plain POST from another site,
// which needs no preflight, is refused.
export const requireJsonBody: RequestHandler = (req, res, next) => {
  if (BODY_METHODS.has(req.method) && !req.is("application/json")) {
    res.status(415).json({ error: JSON_REQUIRED_ERROR });
    return;
  }
  next();
};

// After every route: unknown paths get a short JSON error instead of
// Express's HTML "Cannot GET" page.
export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: "Not found." });
};
