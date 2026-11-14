// Audit log of security-relevant actions, stored in PostgreSQL (audit_logs).
// Only safe metadata is kept: short strings, numbers and booleans under
// allowed keys. Passwords, tokens, secrets and PayPal payloads never reach it.
import type { Pool, PoolClient } from "pg";

export type AuditAction =
  | "auth.register"
  | "auth.login"
  | "auth.logout"
  | "auth.sessions.revoke"
  | "admin.bootstrap"
  | "admin.role.change"
  | "authz.denied"
  | "subscription.create"
  | "subscription.status.change"
  | "subscription.cancel"
  | "webhook.process";

export type AuditEntry = {
  actorUserId: string | null;
  action: AuditAction;
  resourceType: string;
  resourceId?: string | null;
  outcome: "success" | "failure";
  metadata?: Record<string, unknown>;
};

// Keys that may appear in metadata. Anything else is dropped, so a caller
// can't log a secret by accident.
const ALLOWED_METADATA_KEYS = new Set([
  "reason",
  "role",
  "previousRoles",
  "newRoles",
  "permission",
  "path",
  "method",
  "status",
  "previousStatus",
  "eventType",
  "eventId",
  "paymentState", // A PayPal sale's state (completed, refunded, reversed); never amounts or payer data.
  "source",
  "sessions",
  "duplicate",
  "planId",
]);
const SECRET_LIKE = /(password|secret|token|authorization|cookie|key)/i;

export function safeMetadata(metadata: Record<string, unknown> = {}): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!ALLOWED_METADATA_KEYS.has(key) || SECRET_LIKE.test(key)) continue;
    if (typeof value === "string") safe[key] = value.slice(0, 200);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) safe[key] = value;
    else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      safe[key] = value.slice(0, 10).map((item) => item.slice(0, 50));
    }
  }
  return safe;
}

export async function writeAudit(db: Pool | PoolClient, entry: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs (actor_user_id, action, resource_type, resource_id, outcome, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      entry.actorUserId,
      entry.action,
      entry.resourceType,
      entry.resourceId ?? null,
      entry.outcome,
      JSON.stringify(safeMetadata(entry.metadata)),
    ],
  );
}

// Audit writes must never break the request they describe: a failure is
// logged (without the entry's metadata) and swallowed.
export async function tryAudit(db: Pool | PoolClient, entry: AuditEntry): Promise<void> {
  try {
    await writeAudit(db, entry);
  } catch (error) {
    console.error("Audit log write failed:", {
      action: entry.action,
      error: error instanceof Error ? error.message : "unknown error",
    });
  }
}
