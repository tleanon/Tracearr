/**
 * Database client and connection pool
 */

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema.js';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

function createPool(): pg.Pool {
  const p = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.DATABASE_POOL_MAX) || 50,
    idleTimeoutMillis: 20000, // Close idle connections after 20s
    connectionTimeoutMillis: 5000, // Max wait to acquire a connection from the pool (not running query timeout)
    maxUses: 7500, // Max queries per connection before refresh (prevents memory leaks)
    allowExitOnIdle: false, // Keep pool alive during idle periods
  });

  // Log pool errors for debugging
  p.on('error', (err) => {
    console.error('[DB Pool Error]', err.message);
  });

  return p;
}

let pool = createPool();
// Exported as `let` so recreatePool() can reassign it. ESM live bindings ensure
// all modules importing `db` automatically see the new instance after reassignment.
export let db: NodePgDatabase<typeof schema> = drizzle(pool, { schema });

/**
 * Destroy the current pool and create a fresh one.
 * Used after ALTER EXTENSION updates so new connections pick up the updated extension.
 */
export async function recreatePool(): Promise<void> {
  await pool.end();
  pool = createPool();
  db = drizzle(pool, { schema });
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
}

export async function checkDatabaseConnection(): Promise<boolean> {
  let client: pg.PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    if (client) {
      client.release();
    }
  }
}

export async function runMigrations(migrationsFolder: string): Promise<void> {
  await migrate(db, { migrationsFolder });
}
