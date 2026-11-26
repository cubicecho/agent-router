import type { Server } from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import { eq, getTableName, is, sql, Table } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { hashKey, mintKey, WORKER_KEY_PREFIX } from '../server/auth/keys.ts';
import { CALLER_WORKSPACE, type Caller } from '../server/core/context.ts';
import { AGENT_ROUTER_MIGRATIONS } from '../server/db/client.ts';
import { relations } from '../server/db/relations.ts';
import * as dbSchema from '../server/db/schema.ts';
import { agentRevisions } from '../server/db/tables/agent-revisions.ts';
import { agents } from '../server/db/tables/agents.ts';
import { LOCAL_WORKER_NAME, workers } from '../server/db/tables/workers.ts';

/** A database over PGlite in memory, as every test uses. */
export type TestDb = ReturnType<typeof drizzle<typeof relations>>;

/** Every table in the schema, quoted for a statement that names them all. */
const TABLE_LIST = Object.values(dbSchema)
  .flatMap((value) => (is(value, Table) ? [`"${getTableName(value)}"`] : []))
  .join(', ');

/**
 * Builds a fresh in-memory Postgres with this package's migrations applied, the `local` worker they seed included.
 *
 * @returns The database. A file makes one in `beforeAll`, empties it with `resetTestDb`, and closes it in `afterAll`.
 */
export async function createTestDb(): Promise<TestDb> {
  const db = drizzle({ client: new PGlite('memory://'), relations });
  await migrate(db, AGENT_ROUTER_MIGRATIONS);
  return db;
}

/**
 * Empties every table, so the next test starts from the database `createTestDb` returned, with the `local` worker
 * the migration seeds.
 *
 * @param db - A database from `createTestDb`.
 */
export async function resetTestDb(db: TestDb): Promise<void> {
  await db.execute(sql.raw(`TRUNCATE TABLE ${TABLE_LIST} RESTART IDENTITY CASCADE`));
  await db.insert(workers).values({ name: LOCAL_WORKER_NAME });
}

/**
 * Shuts a test database down. One left open holds its whole Postgres in memory until the worker exits.
 *
 * @param db - A database from `createTestDb`.
 */
export async function closeTestDb(db: TestDb): Promise<void> {
  await db.$client.close();
}

/**
 * Inserts a workspace and a key for it, straight through Drizzle.
 *
 * @param db - A database from `createTestDb`.
 * @param slug - The workspace's slug.
 * @param [expiresAt] - When the key stops working.
 * @returns The workspace's id, the key's id and the key itself.
 */
export async function createWorkspaceWithKey(
  db: TestDb,
  slug: string,
  expiresAt: Date | null = null,
): Promise<{ workspaceId: string; keyId: string; secret: string }> {
  const [workspace] = await db.insert(dbSchema.workspaces).values({ slug, name: slug }).returning();
  if (workspace === undefined) {
    throw new Error('The workspace was not inserted.');
  }
  const { secret, start } = mintKey();
  const [key] = await db
    .insert(dbSchema.workspaceKeys)
    .values({ workspaceId: workspace.id, name: 'test', start, hash: hashKey(secret), expiresAt })
    .returning();
  if (key === undefined) {
    throw new Error('The key was not inserted.');
  }
  return { workspaceId: workspace.id, keyId: key.id, secret };
}

/**
 * Inserts a remote worker and its key, straight through Drizzle.
 *
 * @param db - A database from `createTestDb`.
 * @param name - The worker's name.
 * @returns The worker's id and its key.
 */
export async function createWorkerWithKey(db: TestDb, name: string): Promise<{ workerId: string; secret: string }> {
  const { secret, hash, start } = mintKey(WORKER_KEY_PREFIX);
  const [worker] = await db.insert(workers).values({ name, keyHash: hash, keyPrefix: start }).returning();
  if (worker === undefined) {
    throw new Error('The worker was not inserted.');
  }
  return { workerId: worker.id, secret };
}

/**
 * Adds an agent with one live revision, straight through Drizzle, as a person's first save leaves it. Saving through
 * GraphQL is the host's schema, and not what these tests are about.
 *
 * @param db - A database from `createTestDb`.
 * @param document - The `cubicecho.agent/2` document; its `id` is the agent's name.
 * @returns The agent's id and its live revision's.
 */
export async function createAgent(
  db: TestDb,
  document: Record<string, unknown>,
): Promise<{ id: string; liveRevisionId: string }> {
  const name = String(document.id);
  return db.transaction(async (tx) => {
    const [agent] = await tx.insert(agents).values({ name }).returning();
    if (agent === undefined) {
      throw new Error('The agent was not inserted.');
    }
    const [revision] = await tx
      .insert(agentRevisions)
      .values({ agentId: agent.id, number: 1, document, promotedAt: new Date() })
      .returning();
    if (revision === undefined) {
      throw new Error('The revision was not inserted.');
    }
    await tx.update(agents).set({ liveRevisionId: revision.id }).where(eq(agents.id, agent.id));
    return { id: agent.id, liveRevisionId: revision.id };
  });
}

/**
 * The caller a workspace key makes.
 *
 * @param workspaceId - The key's workspace.
 * @param keyId - The key.
 * @returns The caller.
 */
export function workspaceCaller(workspaceId: string, keyId: string): Caller {
  return { kind: CALLER_WORKSPACE, workspaceId, keyId };
}

/**
 * Reads the port a test server was given.
 *
 * @param server - A server listening on port 0.
 * @returns The port the OS picked.
 * @throws If the server is not listening on a TCP port.
 */
export function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The test server is not listening on a TCP port.');
  }
  return address.port;
}
