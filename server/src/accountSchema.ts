// Versioned migrations for accounts, sessions, roles, audit logs and PayPal
// subscriptions. They continue the numbering in schema_migrations that
// PostgresOrderRegistry.initialize() starts (versions 1 and 2, paypal_orders),
// which must run first. paypal_orders is never touched here.
//
// All pending migrations run in one transaction under the same advisory lock
// as the order registry's schema setup, so concurrent instances apply each
// migration exactly once, and a failure leaves the database unchanged.
import type { Pool } from "pg";

type Migration = { version: number; name: string; sql: string };

export const ACCOUNT_MIGRATIONS: Migration[] = [
  {
    version: 3,
    name: "users, roles, sessions, audit logs",
    sql: `
      CREATE TABLE users (
        id UUID PRIMARY KEY,
        email TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT users_email_normalized CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 254)
      );
      CREATE UNIQUE INDEX users_email_key ON users (email);

      CREATE TABLE user_roles (
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'admin')),
        granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
        PRIMARY KEY (user_id, role)
      );

      CREATE TABLE sessions (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        CONSTRAINT sessions_expiry_after_creation CHECK (expires_at > created_at)
      );
      CREATE UNIQUE INDEX sessions_token_hash_key ON sessions (token_hash);
      CREATE INDEX sessions_user_id_idx ON sessions (user_id);
      CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

      CREATE TABLE audit_logs (
        id BIGSERIAL PRIMARY KEY,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT,
        outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      );
      CREATE INDEX audit_logs_occurred_at_idx ON audit_logs (occurred_at DESC);
      CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_user_id);
    `,
  },
  {
    version: 4,
    name: "PayPal subscriptions and webhook events",
    sql: `
      CREATE TABLE subscriptions (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        -- Set once PayPal has created the subscription; unique when set.
        paypal_subscription_id TEXT,
        plan_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('APPROVAL_PENDING', 'APPROVED', 'ACTIVE', 'SUSPENDED', 'CANCELLED', 'EXPIRED')
        ),
        -- PayPal's status_update_time of the state stored here; an older
        -- snapshot never replaces a newer one.
        paypal_status_updated_at TIMESTAMPTZ,
        next_billing_time TIMESTAMPTZ,
        -- When the state was last read from PayPal (API or verified webhook).
        last_verified_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX subscriptions_paypal_id_key
        ON subscriptions (paypal_subscription_id) WHERE paypal_subscription_id IS NOT NULL;
      CREATE INDEX subscriptions_user_status_idx ON subscriptions (user_id, status);

      CREATE TABLE paypal_webhook_events (
        -- PayPal's event id: the idempotency key. A redelivered event is
        -- recognised and never processed twice.
        event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        resource_id TEXT,
        event_created_at TIMESTAMPTZ,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        -- When a delivery last started processing it; a stale PROCESSING
        -- claim (a crashed instance) can be taken over.
        locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ,
        status TEXT NOT NULL CHECK (status IN ('PROCESSING', 'PROCESSED', 'IGNORED', 'FAILED')),
        attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1),
        error TEXT
      );
      CREATE INDEX paypal_webhook_events_resource_idx ON paypal_webhook_events (resource_id);
    `,
  },
  {
    version: 5,
    name: "projects and monthly AI usage",
    sql: `
      CREATE TABLE projects (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
        client_name TEXT NOT NULL DEFAULT '' CHECK (length(client_name) <= 120),
        -- The client's original brief, as the freelancer entered it.
        brief TEXT NOT NULL DEFAULT '' CHECK (length(brief) <= 5000),
        -- AI results and the edited proposal, as the app produced them. The
        -- proposal keeps its own copy of the brief it was drafted from.
        analysis JSONB,
        proposal JSONB,
        risk_review JSONB,
        -- Entered by the freelancer; never filled in by the AI.
        estimated_budget NUMERIC(14, 2) CHECK (estimated_budget >= 0),
        budget_currency TEXT CHECK (budget_currency ~ '^[A-Z]{3}$'),
        deadline DATE,
        status TEXT NOT NULL DEFAULT 'LEAD' CHECK (status IN ('LEAD', 'ACTIVE', 'COMPLETED', 'ARCHIVED')),
        proposal_status TEXT CHECK (proposal_status IN ('DRAFT', 'SENT', 'ACCEPTED', 'REJECTED')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT projects_proposal_status_needs_proposal CHECK (proposal_status IS NULL OR proposal IS NOT NULL)
      );
      CREATE INDEX projects_user_updated_idx ON projects (user_id, updated_at DESC);

      -- Monthly AI usage per user and feature. A row is incremented with a
      -- single conditional upsert, so concurrent requests can't exceed the
      -- plan's limit.
      CREATE TABLE ai_usage (
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        period_start DATE NOT NULL,
        feature TEXT NOT NULL CHECK (feature IN ('analysis')),
        used INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, period_start, feature)
      );
    `,
  },
];

export async function migrateAccountSchema(pool: Pool): Promise<number[]> {
  const client = await pool.connect();
  let failure: Error | undefined;
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT set_config('lock_timeout', '10s', true), set_config('statement_timeout', '30s', true)`,
    );
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('paypilot:schema', 0))");
    const exists = await client.query<{ present: boolean }>(
      "SELECT to_regclass('schema_migrations') IS NOT NULL AS present",
    );
    if (!exists.rows[0]?.present) {
      throw new Error("schema_migrations is missing; initialize the order registry first.");
    }
    const applied = new Set(
      (await client.query<{ version: number }>("SELECT version FROM schema_migrations")).rows.map(
        (row) => row.version,
      ),
    );
    const ran: number[] = [];
    for (const migration of ACCOUNT_MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      await client.query(migration.sql);
      await client.query("INSERT INTO schema_migrations (version, applied_at) VALUES ($1, NOW())", [
        migration.version,
      ]);
      ran.push(migration.version);
    }
    await client.query("COMMIT");
    return ran;
  } catch (error) {
    failure = error instanceof Error ? error : new Error("Account schema migration failed.");
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release(failure);
  }
}
