// Admin API: list users, change a user's role, revoke a user's sessions, and
// read the audit log. Every route checks a specific permission; the role
// names never appear in the checks.
import express from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { writeAudit, tryAudit } from "./auditLog.js";
import { getAuth, type AuthModule } from "./auth.js";
import type { HandlerTracker } from "./gracefulShutdown.js";
import { withTransaction } from "./transaction.js";

const UuidSchema = z.uuid();
const RoleChangeSchema = z.object({ role: z.enum(["user", "admin"]) });

export function createAdminRouter(options: { pool: Pool; auth: AuthModule; trackHandler?: HandlerTracker }) {
  const { pool, auth } = options;
  const track: HandlerTracker = options.trackHandler ?? ((handler) => handler);
  const router = express.Router();
  router.use("/api/admin", auth.requireTrustedOrigin, auth.requireUser);

  router.get(
    "/api/admin/users",
    auth.requirePermission("admin:users:read"),
    track(async (_req, res) => {
      const result = await pool.query(
        `SELECT u.id, u.email, u.created_at,
                COALESCE(array_agg(DISTINCT r.role) FILTER (WHERE r.role IS NOT NULL), '{}') AS roles,
                (SELECT COUNT(*)::int FROM sessions s
                  WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > NOW()) AS active_sessions
           FROM users u LEFT JOIN user_roles r ON r.user_id = u.id
          GROUP BY u.id ORDER BY u.created_at DESC LIMIT 200`,
      );
      return res.json({
        users: result.rows.map((row: { id: string; email: string; created_at: Date; roles: string[]; active_sessions: number }) => ({
          id: row.id,
          email: row.email,
          createdAt: row.created_at.toISOString(),
          roles: row.roles,
          activeSessions: row.active_sessions,
        })),
      });
    }),
  );

  // Sets the user's role to exactly "user" or "admin" (admins keep the user
  // permissions too). An admin can't change their own role, so the last admin
  // can't lock everyone out by accident.
  router.post(
    "/api/admin/users/:id/role",
    auth.requirePermission("admin:users:update"),
    track(async (req, res) => {
      const actor = getAuth(res)!;
      const id = UuidSchema.safeParse(req.params.id);
      const body = RoleChangeSchema.safeParse(req.body);
      if (!id.success || !body.success) return res.status(400).json({ error: "Give a valid user and a role of user or admin." });
      if (id.data === actor.userId) {
        await tryAudit(pool, {
          actorUserId: actor.userId,
          action: "admin.role.change",
          resourceType: "user",
          resourceId: id.data,
          outcome: "failure",
          metadata: { reason: "self_change", role: body.data.role },
        });
        return res.status(403).json({ error: "You cannot change your own role.", code: "SELF_ROLE_CHANGE" });
      }
      const result = await withTransaction(pool, async (client) => {
        // Lock the user, so concurrent role changes apply one after the other.
        const locked = await client.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [id.data]);
        if (locked.rowCount === 0) return undefined;
        const previous = (
          await client.query<{ role: string }>(`SELECT role FROM user_roles WHERE user_id = $1 ORDER BY role`, [id.data])
        ).rows.map((row) => row.role);
        const roles = body.data.role === "admin" ? ["admin", "user"] : ["user"];
        await client.query(`DELETE FROM user_roles WHERE user_id = $1 AND NOT (role = ANY($2::text[]))`, [id.data, roles]);
        for (const role of roles) {
          await client.query(
            `INSERT INTO user_roles (user_id, role, granted_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [id.data, role, actor.userId],
          );
        }
        await writeAudit(client, {
          actorUserId: actor.userId,
          action: "admin.role.change",
          resourceType: "user",
          resourceId: id.data,
          outcome: "success",
          metadata: { previousRoles: previous, newRoles: roles },
        });
        return roles;
      });
      if (!result) return res.status(404).json({ error: "No such user." });
      return res.json({ user: { id: id.data, roles: result } });
    }),
  );

  router.post(
    "/api/admin/users/:id/sessions/revoke",
    auth.requirePermission("admin:users:update"),
    track(async (req, res) => {
      const actor = getAuth(res)!;
      const id = UuidSchema.safeParse(req.params.id);
      if (!id.success) return res.status(400).json({ error: "Give a valid user." });
      const count = await auth.revokeAllSessions(pool, id.data);
      await tryAudit(pool, {
        actorUserId: actor.userId,
        action: "auth.sessions.revoke",
        resourceType: "user",
        resourceId: id.data,
        outcome: "success",
        metadata: { sessions: count, source: "admin" },
      });
      return res.json({ revokedSessions: count });
    }),
  );

  router.get(
    "/api/admin/audit-logs",
    auth.requirePermission("admin:audit:read"),
    track(async (req, res) => {
      const limit = Math.min(200, Math.max(1, Number.parseInt(String(req.query.limit ?? "50"), 10) || 50));
      const result = await pool.query(
        `SELECT id, occurred_at, actor_user_id, action, resource_type, resource_id, outcome, metadata
           FROM audit_logs ORDER BY occurred_at DESC, id DESC LIMIT $1`,
        [limit],
      );
      return res.json({
        entries: result.rows.map(
          (row: {
            id: string;
            occurred_at: Date;
            actor_user_id: string | null;
            action: string;
            resource_type: string;
            resource_id: string | null;
            outcome: string;
            metadata: unknown;
          }) => ({
            id: String(row.id),
            occurredAt: row.occurred_at.toISOString(),
            actorUserId: row.actor_user_id,
            action: row.action,
            resourceType: row.resource_type,
            resourceId: row.resource_id,
            outcome: row.outcome,
            metadata: row.metadata,
          }),
        ),
      });
    }),
  );

  return router;
}
