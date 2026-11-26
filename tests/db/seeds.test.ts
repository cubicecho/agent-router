import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it } from 'vitest';
import { AGENT_ROUTER_MIGRATIONS } from '../../server/db/client.ts';
import { relations } from '../../server/db/relations.ts';
import { LOCAL_WORKER_NAME, workers } from '../../server/db/tables/workers.ts';

// The migrations run on a fresh PGlite, past Vitest's 5 s default when the machine is busy.
const MIGRATE_TIMEOUT_MS = 30_000;

describe('the migrations', () => {
  it('seed the local worker, as the code describes it, and record themselves in their own table', {
    timeout: MIGRATE_TIMEOUT_MS,
  }, async () => {
    const client = new PGlite('memory://');
    const db = drizzle({ client, relations });
    try {
      await migrate(db, AGENT_ROUTER_MIGRATIONS);
      const seededWorkers = await db
        .select({ name: workers.name, keyHash: workers.keyHash, keyPrefix: workers.keyPrefix, keySet: workers.keySet })
        .from(workers);
      expect(seededWorkers).toEqual([{ name: LOCAL_WORKER_NAME, keyHash: null, keyPrefix: null, keySet: false }]);
      const { rows } = await client.query<{ count: number }>(
        `select count(*)::int as count from drizzle.${AGENT_ROUTER_MIGRATIONS.migrationsTable}`,
      );
      expect(rows[0]?.count).toBe(1);
      expect(path.basename(AGENT_ROUTER_MIGRATIONS.migrationsFolder)).toBe('drizzle');
    } finally {
      await client.close();
    }
  });
});
