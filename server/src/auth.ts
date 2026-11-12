// Accounts and server-side sessions.
//
// - Passwords: scrypt (passwords.ts); never stored, logged or returned.
// - Sessions: a random 256-bit token in an HttpOnly cookie. PostgreSQL stores
//   only its SHA-256 hash, with an absolute expiry; logout and revocation
//   mark it revoked. Login and registration always start a new session and
//   revoke the one the browser presented (no session fixation).
// - CSRF: the cookie is only accepted on state-changing requests that carry
//   an Origin header from CLIENT_ORIGINS (rejectDisallowedOrigins already
//   refuses other origins), and those requests must be JSON, which forces a
//   CORS preflight.
// - Authorization: requirePermission() checks permissions from the user's
//   roles, read from the database on every request (permissions.ts).
import express, { type Request, type RequestHandler, type Response } from "express";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { tryAudit, writeAudit } from "./auditLog.js";
import {
  DEFAULT_SCRYPT_PARAMS,
  PASSWORD_MAX_LENGTH,
  hashPassword,
  passwordProblem,
  verifyPassword,
  type ScryptParams,
} from "./passwords.js";
import { permissionsFor, type Permission } from "./permissions.js";
import type { HandlerTracker } from "./gracefulShutdown.js";
import { createRateLimiter } from "./rateLimit.js";
import { withTransaction } from "./transaction.js";

type Logger = { error: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void };

// ---- Cookie configuration ---------------------------------------------------

export type SameSite = "Lax" | "Strict" | "None";

export type SessionCookieConfig = {
  name: string;
  secure: boolean;
  sameSite: SameSite;
  // CHIPS: lets the cookie work when the frontend and the API are different
  // sites (Cloudflare and Render) in browsers that partition third-party
  // cookies. Set together with SameSite=None.
  partitioned: boolean;
  ttlMs: number;
};

const HOUR = 3_600_000;

// SESSION_COOKIE_SAMESITE: lax | strict | none. The default is "none" in
// production, where the frontend and API are on different sites, and "lax"
// locally (localhost:5173 and localhost:4000 are the same site).
// SESSION_COOKIE_SECURE: true | false; default true in production.
// SESSION_TTL_HOURS: absolute session lifetime, 1 to 720; default 168 (7 days).
export function readSessionCookieConfig(
  env: Record<string, string | undefined>,
  logger: Logger = console,
): SessionCookieConfig {
  const production = env.NODE_ENV === "production";
  let secure = production;
  const secureValue = env.SESSION_COOKIE_SECURE?.trim().toLowerCase();
  if (secureValue === "true") secure = true;
  else if (secureValue === "false") secure = false;
  else if (secureValue) logger.error("SESSION_COOKIE_SECURE must be true or false; using the default.");

  const sameSiteValue = env.SESSION_COOKIE_SAMESITE?.trim().toLowerCase();
  const sameSites: Record<string, SameSite> = { lax: "Lax", strict: "Strict", none: "None" };
  let sameSite: SameSite = production ? "None" : "Lax";
  if (sameSiteValue && sameSites[sameSiteValue]) sameSite = sameSites[sameSiteValue];
  else if (sameSiteValue) logger.error("SESSION_COOKIE_SAMESITE must be lax, strict or none; using the default.");

  if (sameSite === "None" && !secure) {
    // Browsers drop SameSite=None cookies that are not Secure.
    logger.error("SESSION_COOKIE_SAMESITE=none requires a Secure cookie; marking the session cookie Secure.");
    secure = true;
  }

  let ttlHours = 168;
  const ttlValue = env.SESSION_TTL_HOURS?.trim();
  if (ttlValue) {
    const parsed = Number(ttlValue);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 720) ttlHours = parsed;
    else logger.error("SESSION_TTL_HOURS must be a whole number from 1 to 720; using 168.");
  }

  return {
    // The __Host- prefix makes browsers refuse the cookie unless it is Secure,
    // has Path=/ and no Domain, so another subdomain can't set or shadow it.
    name: secure ? "__Host-paypilot_session" : "paypilot_session",
    secure,
    sameSite,
    partitioned: sameSite === "None",
    ttlMs: ttlHours * HOUR,
  };
}

export function serializeSessionCookie(config: SessionCookieConfig, value: string, maxAgeSeconds: number): string {
  const parts = [
    `${config.name}=${value}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${config.sameSite}`,
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (config.secure) parts.push("Secure");
  if (config.partitioned) parts.push("Partitioned");
  return parts.join("; ");
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

// ---- Session tokens ---------------------------------------------------------

const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function createSessionToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashSessionToken(token) };
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function isWellFormedSessionToken(value: unknown): value is string {
  return typeof value === "string" && SESSION_TOKEN_PATTERN.test(value);
}

// ---- Request context --------------------------------------------------------

export type AuthContext = {
  userId: string;
  email: string;
  roles: string[];
  permissions: Set<Permission>;
  sessionId: string;
};

export function getAuth(res: Response): AuthContext | undefined {
  return res.locals.auth as AuthContext | undefined;
}

export function userView(auth: AuthContext) {
  return {
    id: auth.userId,
    email: auth.email,
    roles: [...auth.roles].sort(),
    permissions: [...auth.permissions].sort(),
  };
}

export const AUTH_REQUIRED = { error: "Sign in to continue.", code: "AUTH_REQUIRED" } as const;
export const FORBIDDEN = { error: "You do not have permission to do this.", code: "FORBIDDEN" } as const;
export const COOKIE_ORIGIN_REQUIRED = {
  error: "Requests signed in with a session must come from the PayPilot web app.",
  code: "ORIGIN_REQUIRED",
} as const;
const AUTH_UNAVAILABLE = { error: "Sign-in is temporarily unavailable. Try again shortly.", code: "AUTH_UNAVAILABLE" } as const;
const INVALID_CREDENTIALS = { error: "The email or password is incorrect.", code: "INVALID_CREDENTIALS" } as const;

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const EmailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());
const CredentialsSchema = z.object({
  email: EmailSchema,
  // Checked in full by passwordProblem; the cap only bounds the body.
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH * 4),
});

export type AuthModuleOptions = {
  pool: Pool;
  allowedOrigins: string[];
  cookie: SessionCookieConfig;
  now?: () => number;
  passwordParams?: ScryptParams;
  limits?: {
    registerPerHourPerClient?: number;
    loginPer10MinutesPerClient?: number;
    // Failed logins per email address within 15 minutes before that address
    // is refused for the rest of the window.
    failedLoginsPerEmail?: number;
  };
  trackHandler?: HandlerTracker;
  logger?: Logger;
};

type SessionRow = { session_id: string; user_id: string; email: string; roles: string[] };

export function createAuthModule(options: AuthModuleOptions) {
  const { pool, cookie } = options;
  const now = options.now ?? Date.now;
  const params = options.passwordParams ?? DEFAULT_SCRYPT_PARAMS;
  const track: HandlerTracker = options.trackHandler ?? ((handler) => handler);
  const logger = options.logger ?? console;
  const allowedOrigins = new Set(options.allowedOrigins);

  // Verified against when an email is unknown, so a login takes as long
  // whether or not the account exists.
  let dummyHash: Promise<string> | undefined;
  const getDummyHash = () => (dummyHash ??= hashPassword(randomBytes(16).toString("hex"), params));

  // ---- Failed-login tracking (per email address, in memory) ----------------
  const failedLogins = new Map<string, { count: number; resetAt: number }>();
  const maxFailures = options.limits?.failedLoginsPerEmail ?? 5;
  const FAILURE_WINDOW_MS = 15 * 60_000;
  function isLockedOut(email: string): boolean {
    const entry = failedLogins.get(email);
    if (!entry) return false;
    if (entry.resetAt <= now()) {
      failedLogins.delete(email);
      return false;
    }
    return entry.count >= maxFailures;
  }
  function recordFailure(email: string) {
    const time = now();
    const entry = failedLogins.get(email);
    if (!entry || entry.resetAt <= time) {
      if (failedLogins.size >= 10_000) {
        for (const [key, value] of failedLogins) if (value.resetAt <= time) failedLogins.delete(key);
      }
      if (failedLogins.size < 10_000) failedLogins.set(email, { count: 1, resetAt: time + FAILURE_WINDOW_MS });
      return;
    }
    entry.count++;
  }

  const registerLimiter = createRateLimiter({
    now,
    rules: [
      {
        scope: "client",
        windowMs: 60 * 60_000,
        max: options.limits?.registerPerHourPerClient ?? 10,
        message: "Too many accounts created from this address. Try again later.",
      },
    ],
  });
  const loginLimiter = createRateLimiter({
    now,
    rules: [
      {
        scope: "client",
        windowMs: 10 * 60_000,
        max: options.limits?.loginPer10MinutesPerClient ?? 20,
        message: "Too many sign-in attempts. Wait a few minutes and try again.",
      },
    ],
  });

  // ---- Sessions -------------------------------------------------------------

  async function findSession(token: string): Promise<SessionRow | undefined> {
    const result = await pool.query<SessionRow>(
      `SELECT s.id AS session_id, u.id AS user_id, u.email,
              COALESCE(array_agg(r.role ORDER BY r.role) FILTER (WHERE r.role IS NOT NULL), '{}') AS roles
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN user_roles r ON r.user_id = u.id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2
        GROUP BY s.id, u.id`,
      [hashSessionToken(token), new Date(now())],
    );
    return result.rows[0];
  }

  async function startSession(client: PoolClient, userId: string): Promise<string> {
    const { token, hash } = createSessionToken();
    const created = new Date(now());
    await client.query(
      `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at) VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), userId, hash, created, new Date(created.getTime() + cookie.ttlMs)],
    );
    return token;
  }

  // Revokes the session the browser presented, if any (session fixation).
  async function revokePresentedSession(client: PoolClient, req: Request): Promise<void> {
    const presented = readCookie(req.get("cookie"), cookie.name);
    if (!isWellFormedSessionToken(presented)) return;
    await client.query(`UPDATE sessions SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL`, [
      hashSessionToken(presented),
      new Date(now()),
    ]);
  }

  function setSessionCookie(res: Response, token: string) {
    res.append("Set-Cookie", serializeSessionCookie(cookie, token, cookie.ttlMs / 1000));
  }
  function clearSessionCookie(res: Response) {
    res.append("Set-Cookie", serializeSessionCookie(cookie, "", 0));
  }

  async function revokeAllSessions(db: Pool | PoolClient, userId: string): Promise<number> {
    const result = await db.query(
      `UPDATE sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > $2`,
      [userId, new Date(now())],
    );
    return result.rowCount ?? 0;
  }

  // ---- Middleware -----------------------------------------------------------

  // Reads the session cookie (if any) into res.locals.auth. Never rejects a
  // request for lacking a session; requireUser does that.
  const authenticate: RequestHandler = async (req, res, next) => {
    const token = readCookie(req.get("cookie"), cookie.name);
    if (token === undefined || token === "") return next();
    if (UNSAFE_METHODS.has(req.method)) {
      const origin = req.get("origin");
      if (!origin || !allowedOrigins.has(origin)) {
        res.status(403).json(COOKIE_ORIGIN_REQUIRED);
        return;
      }
    }
    if (!isWellFormedSessionToken(token)) return next();
    try {
      const row = await findSession(token);
      if (row) {
        const auth: AuthContext = {
          userId: row.user_id,
          email: row.email,
          roles: row.roles,
          permissions: permissionsFor(row.roles),
          sessionId: row.session_id,
        };
        res.locals.auth = auth;
      }
    } catch (error) {
      logger.error("Session lookup failed:", error instanceof Error ? error.message : "unknown error");
      res.locals.authUnavailable = true;
    }
    next();
  };

  const requireUser: RequestHandler = (_req, res, next) => {
    if (getAuth(res)) return next();
    if (res.locals.authUnavailable) {
      res.status(503).json(AUTH_UNAVAILABLE);
      return;
    }
    res.status(401).json(AUTH_REQUIRED);
  };

  function requirePermission(permission: Permission): RequestHandler {
    return async (req, res, next) => {
      const auth = getAuth(res);
      if (!auth) {
        res.status(res.locals.authUnavailable ? 503 : 401).json(res.locals.authUnavailable ? AUTH_UNAVAILABLE : AUTH_REQUIRED);
        return;
      }
      if (auth.permissions.has(permission)) return next();
      await tryAudit(pool, {
        actorUserId: auth.userId,
        action: "authz.denied",
        resourceType: "route",
        resourceId: `${req.method} ${req.baseUrl}${req.path}`.slice(0, 200),
        outcome: "failure",
        metadata: { permission },
      });
      res.status(403).json(FORBIDDEN);
    };
  }

  // State-changing account requests must come from an allowed browser origin,
  // even before a session exists (prevents login CSRF).
  const requireTrustedOrigin: RequestHandler = (req, res, next) => {
    if (!UNSAFE_METHODS.has(req.method)) return next();
    const origin = req.get("origin");
    if (origin && allowedOrigins.has(origin)) return next();
    res.status(403).json(COOKIE_ORIGIN_REQUIRED);
  };

  // ---- Routes ---------------------------------------------------------------

  const router = express.Router();
  router.use("/api/auth", requireTrustedOrigin);

  router.post(
    "/api/auth/register",
    registerLimiter,
    track(async (req, res) => {
      const parsed = CredentialsSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Enter a valid email address and a password.", code: "INVALID_INPUT" });
      }
      const { email, password } = parsed.data;
      const problem = passwordProblem(password, email);
      if (problem) return res.status(400).json({ error: problem, code: "WEAK_PASSWORD" });

      const passwordHash = await hashPassword(password, params);
      const outcome = await withTransaction(pool, async (client) => {
        const userId = randomUUID();
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)
           ON CONFLICT (email) DO NOTHING RETURNING id`,
          [userId, email, passwordHash],
        );
        if (inserted.rowCount === 0) return undefined;
        // Public registration only ever grants "user"; any role in the body
        // is ignored. Admins are created by bootstrapAdmin or by an admin.
        await client.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'user')`, [userId]);
        await revokePresentedSession(client, req);
        const token = await startSession(client, userId);
        await writeAudit(client, {
          actorUserId: userId,
          action: "auth.register",
          resourceType: "user",
          resourceId: userId,
          outcome: "success",
        });
        return { userId, token };
      });

      if (!outcome) {
        await tryAudit(pool, {
          actorUserId: null,
          action: "auth.register",
          resourceType: "user",
          outcome: "failure",
          metadata: { reason: "duplicate_email" },
        });
        return res.status(409).json({ error: "An account with this email already exists. Sign in instead.", code: "EMAIL_TAKEN" });
      }

      setSessionCookie(res, outcome.token);
      const roles = ["user"];
      return res.status(201).json({
        user: { id: outcome.userId, email, roles, permissions: [...permissionsFor(roles)].sort() },
      });
    }),
  );

  router.post(
    "/api/auth/login",
    loginLimiter,
    track(async (req, res) => {
      const parsed = CredentialsSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Enter your email address and password.", code: "INVALID_INPUT" });
      const { email, password } = parsed.data;

      if (isLockedOut(email)) {
        await tryAudit(pool, {
          actorUserId: null,
          action: "auth.login",
          resourceType: "user",
          outcome: "failure",
          metadata: { reason: "locked_out" },
        });
        res.setHeader("Retry-After", String(FAILURE_WINDOW_MS / 1000));
        return res.status(429).json({ error: "Too many failed sign-in attempts for this account. Try again later.", code: "LOCKED_OUT" });
      }

      const found = await pool.query<{ id: string; password_hash: string }>(
        `SELECT id, password_hash FROM users WHERE email = $1`,
        [email],
      );
      const user = found.rows[0];
      const valid = await verifyPassword(password, user?.password_hash ?? (await getDummyHash()));
      if (!user || !valid) {
        recordFailure(email);
        await tryAudit(pool, {
          actorUserId: user?.id ?? null,
          action: "auth.login",
          resourceType: "user",
          resourceId: user?.id ?? null,
          outcome: "failure",
          metadata: { reason: user ? "wrong_password" : "unknown_email" },
        });
        return res.status(401).json(INVALID_CREDENTIALS);
      }

      failedLogins.delete(email);
      const token = await withTransaction(pool, async (client) => {
        await revokePresentedSession(client, req);
        const started = await startSession(client, user.id);
        await writeAudit(client, {
          actorUserId: user.id,
          action: "auth.login",
          resourceType: "user",
          resourceId: user.id,
          outcome: "success",
        });
        return started;
      });
      const session = await findSession(token);
      setSessionCookie(res, token);
      const roles = session?.roles ?? ["user"];
      return res.json({ user: { id: user.id, email, roles, permissions: [...permissionsFor(roles)].sort() } });
    }),
  );

  router.post(
    "/api/auth/logout",
    track(async (req, res) => {
      const token = readCookie(req.get("cookie"), cookie.name);
      if (isWellFormedSessionToken(token)) {
        const revoked = await pool.query<{ user_id: string; id: string }>(
          `UPDATE sessions SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL RETURNING user_id, id`,
          [hashSessionToken(token), new Date(now())],
        );
        const row = revoked.rows[0];
        if (row) {
          await tryAudit(pool, {
            actorUserId: row.user_id,
            action: "auth.logout",
            resourceType: "session",
            resourceId: row.id,
            outcome: "success",
          });
        }
      }
      clearSessionCookie(res);
      return res.json({ signedOut: true });
    }),
  );

  router.get("/api/auth/me", requireUser, (_req, res) => {
    res.json({ user: userView(getAuth(res)!) });
  });

  // Signs this account out everywhere, including this browser.
  router.post(
    "/api/auth/sessions/revoke-all",
    requireUser,
    track(async (_req, res) => {
      const auth = getAuth(res)!;
      const count = await revokeAllSessions(pool, auth.userId);
      await tryAudit(pool, {
        actorUserId: auth.userId,
        action: "auth.sessions.revoke",
        resourceType: "user",
        resourceId: auth.userId,
        outcome: "success",
        metadata: { sessions: count, source: "self" },
      });
      clearSessionCookie(res);
      return res.json({ revokedSessions: count });
    }),
  );

  // ---- Bootstrap admin ------------------------------------------------------

  // BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD: creates that account
  // as an admin at startup if it does not exist. An existing account is never
  // promoted, because whoever registered the address first owns its password.
  async function bootstrapAdmin(emailValue: string | undefined, password: string | undefined): Promise<void> {
    if (!emailValue?.trim() && !password) return;
    const email = EmailSchema.safeParse(emailValue ?? "");
    if (!email.success || !password) {
      logger.error("BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD must both be set and valid; no admin was created.");
      return;
    }
    const problem = passwordProblem(password, email.data);
    if (problem) {
      logger.error(`BOOTSTRAP_ADMIN_PASSWORD is not acceptable (${problem}); no admin was created.`);
      return;
    }
    const passwordHash = await hashPassword(password, params);
    const result = await withTransaction(pool, async (client) => {
      const userId = randomUUID();
      const inserted = await client.query(
        `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING`,
        [userId, email.data, passwordHash],
      );
      if (inserted.rowCount === 0) {
        const existing = await client.query<{ admin: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM users u JOIN user_roles r ON r.user_id = u.id WHERE u.email = $1 AND r.role = 'admin'
           ) AS admin`,
          [email.data],
        );
        return existing.rows[0]?.admin ? "exists" : "not-promoted";
      }
      await client.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'user'), ($1, 'admin')`, [userId]);
      await writeAudit(client, {
        actorUserId: null,
        action: "admin.bootstrap",
        resourceType: "user",
        resourceId: userId,
        outcome: "success",
        metadata: { role: "admin", source: "BOOTSTRAP_ADMIN_EMAIL" },
      });
      return "created";
    });
    if (result === "created") console.log("Bootstrap admin account created.");
    if (result === "not-promoted") {
      (logger.warn ?? logger.error)(
        "BOOTSTRAP_ADMIN_EMAIL belongs to an existing non-admin account; it was not promoted. Grant the role from an existing admin account instead.",
      );
    }
  }

  return {
    router,
    authenticate,
    requireUser,
    requirePermission,
    requireTrustedOrigin,
    revokeAllSessions,
    bootstrapAdmin,
  };
}

export type AuthModule = ReturnType<typeof createAuthModule>;
