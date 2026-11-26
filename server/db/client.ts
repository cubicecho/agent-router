import path from 'node:path';
import type { PgAsyncDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { ROOT } from '../core/config.ts';
import type { relations } from './relations.ts';

/**
 * The Drizzle client this package's code reads and writes through: the host's Postgres, over this package's tables.
 * The host opens it, claims it and closes it; tests pass PGlite, which runs the same SQL.
 */
export type DB = PgAsyncDatabase<PgQueryResultHKT, typeof relations>;
/** The transaction a write and its checks run in. */
export type Transaction = Parameters<Parameters<DB['transaction']>[0]>[0];

/**
 * Where this package's migrations are, and the table that records which ran. The host applies them with its own
 * driver's `migrate`, beside its own and other packages': `migrate(db, AGENT_ROUTER_MIGRATIONS)`.
 */
export const AGENT_ROUTER_MIGRATIONS = Object.freeze({
  migrationsFolder: path.join(ROOT, 'drizzle'),
  migrationsTable: '__agent_router_migrations',
});
