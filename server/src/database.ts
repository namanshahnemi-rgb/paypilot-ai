
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type DatabaseOptions = {
  filename: string;
};

export function openDatabase(options: DatabaseOptions): Database.Database {
  const isMemoryDatabase = options.filename === ":memory:";
  const filename = isMemoryDatabase
    ? ":memory:"
    : path.resolve(options.filename);

  if (!isMemoryDatabase) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
  }

  const db = new Database(filename);

  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS paypal_orders (
      order_id TEXT PRIMARY KEY,
      expected_amount TEXT NOT NULL,
      expected_currency TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payment_status TEXT NOT NULL CHECK (
        payment_status IN (
          'CREATED',
          'PAID',
          'PENDING',
          'FAILED',
          'NEEDS_REVIEW',
          'UNKNOWN'
        )
      ),
      order_status TEXT,
      capture_status TEXT,
      captured_amount TEXT,
      captured_currency TEXT,
      message TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_paypal_orders_status
      ON paypal_orders(payment_status);

    CREATE INDEX IF NOT EXISTS idx_paypal_orders_created_at
      ON paypal_orders(created_at);
  `);

  db.prepare(`
    INSERT OR IGNORE INTO schema_migrations (version, applied_at)
    VALUES (1, ?)
  `).run(new Date().toISOString());

  return db;
}
