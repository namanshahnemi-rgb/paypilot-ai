// Runs `work` in one PostgreSQL transaction: COMMIT on success, ROLLBACK on
// any error. A connection whose transaction failed is discarded rather than
// returned to the pool, as in postgresOrderRegistry.ts.
import type { Pool, PoolClient } from "pg";

export async function withTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let failure: Error | undefined;
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    failure = error instanceof Error ? error : new Error("Transaction failed.");
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release(failure);
  }
}
