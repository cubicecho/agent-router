import { setTimeout as sleep } from 'node:timers/promises';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { errorMessage } from '../core/errors.ts';
import { AGENT_ROUTER_MIGRATIONS, type DB } from '../db/client.ts';
import { relations } from '../db/relations.ts';

// The standalone host's Postgres: opened, waited for, claimed and migrated at boot, closed at shutdown.

/** What `pg_try_advisory_lock` is asked for: one lock per database, the same in every standalone agent-router. */
const ADVISORY_LOCK_NAME = 'agent-router';

/** How boot waits for a Postgres that is still starting. */
const WAIT: Readonly<{ timeoutMs: number; firstDelayMs: number; maxDelayMs: number; backoff: number }> = Object.freeze({
  timeoutMs: 30_000,
  firstDelayMs: 250,
  maxDelayMs: 4_000,
  backoff: 2,
});

/** What a Postgres that is still starting looks like from here. Anything else is a real failure. */
const RETRYABLE_CODES: readonly string[] = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  '57P03',
];

/** The standalone host's Postgres, and what boot and shutdown do with it. */
export interface StandaloneDatabase {
  db: DB;
  /** Where it is, for the boot log, with no password in it. */
  location: string;
  /** Resolves once Postgres answers, retrying while it is starting. */
  waitUntilUp: () => Promise<void>;
  /** Makes this process the database's only agent-router, or throws. */
  claim: () => Promise<void>;
  /** Applies agent-router's migrations. */
  migrate: () => Promise<void>;
  /** Releases the claim and closes the pool. */
  close: () => Promise<void>;
}

/**
 * Reads the driver or errno code of an error, or of what caused it: Drizzle wraps the driver's.
 *
 * @param error - Whatever was thrown.
 * @returns The code, or undefined.
 */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  if ('code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return 'cause' in error ? errorCode(error.cause) : undefined;
}

/**
 * Opens the standalone host's Postgres. Nothing connects until the first query.
 *
 * @param connectionString - A postgres:// URL.
 * @returns The database, not yet claimed or migrated.
 */
export function openStandaloneDatabase(connectionString: string): StandaloneDatabase {
  const pool = new pg.Pool({ connectionString });
  const client = drizzle({ client: pool, relations });
  const db: DB = client;
  const url = new URL(connectionString);
  let lockHolder: pg.PoolClient | null = null;
  return {
    db,
    location: `postgres ${url.hostname}${url.pathname}`,
    waitUntilUp: async () => {
      const deadline = Date.now() + WAIT.timeoutMs;
      let delayMs = WAIT.firstDelayMs;
      for (;;) {
        try {
          await db.execute(sql`select 1`);
          return;
        } catch (error) {
          const code = errorCode(error);
          const isWorthWaiting = code !== undefined && RETRYABLE_CODES.includes(code);
          if (isWorthWaiting === false || Date.now() + delayMs > deadline) {
            throw error;
          }
          console.log(`[db] Postgres is not answering yet (${code}). Trying again in ${delayMs} ms.`);
          await sleep(delayMs);
          delayMs = Math.min(delayMs * WAIT.backoff, WAIT.maxDelayMs);
        }
      }
    },
    claim: async () => {
      const connection = await pool.connect();
      try {
        const result = await connection.query<{ locked: boolean }>(
          'select pg_try_advisory_lock(hashtext($1)) as locked',
          [ADVISORY_LOCK_NAME],
        );
        if (result.rows[0]?.locked !== true) {
          throw new Error(
            'Another agent-router is already using this database. Two on one database would route from different snapshots, so this one is stopping.',
          );
        }
      } catch (error) {
        connection.release();
        throw error;
      }
      lockHolder = connection;
    },
    migrate: async () => {
      await migrate(client, AGENT_ROUTER_MIGRATIONS);
    },
    close: async () => {
      const holder = lockHolder;
      lockHolder = null;
      if (holder !== null) {
        try {
          await holder.query('select pg_advisory_unlock(hashtext($1))', [ADVISORY_LOCK_NAME]);
        } catch (error) {
          // Closing the connection drops the lock anyway.
          console.warn(`[db] could not release the advisory lock: ${errorMessage(error)}`);
        }
        holder.release();
      }
      await pool.end();
    },
  };
}
