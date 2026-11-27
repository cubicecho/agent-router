import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runnableAgent } from '../../server/agents/start.ts';
import { AdminRole } from '../../server/core/admin-roles.ts';
import { CALLER_RUN } from '../../server/core/context.ts';
import { ErrorCode } from '../../server/core/errors.ts';
import { workspaceAgentDisabledServers } from '../../server/db/tables/workspace-agent-disabled-servers.ts';
import { workspaceAgentDisabledTools } from '../../server/db/tables/workspace-agent-disabled-tools.ts';
import { workspaceAgents } from '../../server/db/tables/workspace-agents.ts';
import { workspaceKeys } from '../../server/db/tables/workspace-keys.ts';
import { workspaces } from '../../server/db/tables/workspaces.ts';
import { FakeHost } from '../fake-host.ts';
import { createClient, personCaller, type TestClient } from '../graphql-client.ts';
import {
  closeTestDb,
  createTestDb,
  createWorkspaceWithKey,
  resetTestDb,
  type TestDb,
  workspaceCaller,
} from '../helpers.ts';

// copyWorkspace copies this package's rows: the workspace, its agents, its worker and their switches. The server
// entries are the host's, which the lifecycle port is told to copy.

const CREATE_AGENT = 'mutation ($document: JSON!) { createAgent(document: $document) { id } }';
const OFFER = 'mutation ($v: CreateWorkspaceAgentInput!) { createWorkspaceAgent(values: $v) { id } }';
const COPY = `mutation ($fromWorkspaceId: UUID!, $slug: String!, $name: String!, $description: String) {
  copyWorkspace(fromWorkspaceId: $fromWorkspaceId, slug: $slug, name: $name, description: $description) {
    id slug name description
  }
}`;
const MISSING_ID = '00000000-0000-4000-8000-000000000000';

/** An agent the workspaces run. */
const FINANCE = {
  spec: 'cubicecho.agent/2',
  id: 'personal-finance',
  model: { model: 'fake/m1' },
  prompt: [{ role: 'system', name: 'identity', content: 'You help me run my household money.' }],
};

let db: TestDb;
let host: FakeHost;
let asUser: TestClient;
let sourceId: string;
let keyId: string;
let financeEntryId: string;
let coderEntryId: string;
let serverIds: Record<'actual' | 'github', string>;

/**
 * Puts an agent in the source workspace, as a person does.
 *
 * @param id - The agent's name.
 * @returns The workspace's entry for it.
 */
async function offer(id: string): Promise<string> {
  const agentId = (await asUser.expectOk(CREATE_AGENT, { document: { ...FINANCE, id } })).createAgent.id;
  return (await asUser.expectOk(OFFER, { v: { workspaceId: sourceId, agentId } })).createWorkspaceAgent.id;
}

/**
 * Reads the servers a workspace's apps would reach with an agent, from the client's snapshot.
 *
 * @param workspaceId - The workspace.
 * @param name - The agent.
 * @returns Their names, or null when the workspace may not run it.
 */
async function reached(workspaceId: string, name: string): Promise<readonly string[] | null> {
  return runnableAgent((await asUser.snapshot()).current().agents, workspaceId, name)?.servers ?? null;
}

/**
 * Copies the source workspace as a person does.
 *
 * @param [slug] - The new workspace's slug.
 * @returns The new workspace's id.
 */
async function copy(slug = 'second-app'): Promise<string> {
  const { copyWorkspace } = await asUser.expectOk(COPY, { fromWorkspaceId: sourceId, slug, name: 'Second app' });
  return copyWorkspace.id;
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(() => closeTestDb(db));

beforeEach(async () => {
  await resetTestDb(db);
  host = new FakeHost();
  asUser = createClient(db, personCaller(), { host });
  serverIds = { actual: host.addServer('actual', 'node', []).id, github: host.addServer('github', 'node', []).id };
  ({ workspaceId: sourceId, keyId } = await createWorkspaceWithKey(db, 'task-server'));
  host.addToWorkspace(sourceId, serverIds.actual);
  host.addToWorkspace(sourceId, serverIds.github);
  financeEntryId = await offer('personal-finance');
  coderEntryId = await offer('coder');
  await db.insert(workspaceAgentDisabledServers).values([
    { workspaceAgentId: financeEntryId, serverId: serverIds.github },
    { workspaceAgentId: coderEntryId, serverId: serverIds.actual },
  ]);
  await db
    .insert(workspaceAgentDisabledTools)
    .values({ workspaceAgentId: coderEntryId, serverId: serverIds.github, tool: 'delete_repo' });
});

describe('copying a workspace', () => {
  it('makes a workspace with the same agents, and the same reach for each', async () => {
    const copyId = await copy();
    for (const agent of ['personal-finance', 'coder']) {
      expect(await reached(copyId, agent)).toEqual(await reached(sourceId, agent));
    }
    expect(await reached(copyId, 'personal-finance')).toEqual(['actual']);
    expect(await reached(copyId, 'coder')).toEqual(['github']);
    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, copyId));
    expect(workspace).toMatchObject({ slug: 'second-app', name: 'Second app', description: '' });
  });

  it('tells the host, with each workspace agent of the original mapped to its copy', async () => {
    const copyId = await copy();
    const copied = await db
      .select({ id: workspaceAgents.id, agentId: workspaceAgents.agentId })
      .from(workspaceAgents)
      .where(eq(workspaceAgents.workspaceId, copyId));
    const original = await db
      .select({ id: workspaceAgents.id, agentId: workspaceAgents.agentId })
      .from(workspaceAgents)
      .where(eq(workspaceAgents.workspaceId, sourceId));
    const copyOf = new Map(copied.map((entry) => [entry.agentId, entry.id]));
    expect(host.copied).toEqual([
      {
        from: sourceId,
        to: copyId,
        workspaceAgentIds: new Map(original.map((entry) => [entry.id, copyOf.get(entry.agentId)])),
      },
    ]);
    expect(host.copied[0]?.workspaceAgentIds.get(financeEntryId)).not.toBe(financeEntryId);
  });

  it('copies the tools turned off for each agent', async () => {
    const copyId = await copy();
    const [coderCopy] = await db
      .select({ id: workspaceAgents.id })
      .from(workspaceAgents)
      .innerJoin(workspaceAgentDisabledTools, eq(workspaceAgentDisabledTools.workspaceAgentId, workspaceAgents.id))
      .where(eq(workspaceAgents.workspaceId, copyId));
    const tools = await db
      .select({ serverId: workspaceAgentDisabledTools.serverId, tool: workspaceAgentDisabledTools.tool })
      .from(workspaceAgentDisabledTools)
      .where(eq(workspaceAgentDisabledTools.workspaceAgentId, coderCopy?.id ?? MISSING_ID));
    expect(tools).toEqual([{ serverId: serverIds.github, tool: 'delete_repo' }]);
    expect(coderCopy?.id).not.toBe(coderEntryId);
  });

  it('never copies keys', async () => {
    const copyId = await copy();
    expect(await db.select().from(workspaceKeys).where(eq(workspaceKeys.workspaceId, copyId))).toEqual([]);
  });

  it('is done when the host fails to copy its rows, which is logged', async () => {
    host.lifecycleFailure = new Error('the host is down');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await copy();
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('lifecycle.workspaceCopied'), 'the host is down');
    } finally {
      logged.mockRestore();
    }
    expect(await db.select({ id: workspaces.id }).from(workspaces)).toHaveLength(2);
  });

  it('refuses a bad slug, a taken one or an unknown source, changing nothing and telling the host nothing', async () => {
    const refusals = [
      { args: { fromWorkspaceId: sourceId, slug: 'Bad Slug', name: 'x' }, code: ErrorCode.BadUserInput },
      { args: { fromWorkspaceId: sourceId, slug: 'task-server', name: 'x' }, code: ErrorCode.BadUserInput },
      { args: { fromWorkspaceId: sourceId, slug: 'second-app', name: ' ' }, code: ErrorCode.BadUserInput },
      { args: { fromWorkspaceId: MISSING_ID, slug: 'second-app', name: 'x' }, code: ErrorCode.NotFound },
    ];
    for (const { args, code } of refusals) {
      expect((await asUser.expectError(COPY, args)).code).toBe(code);
    }
    expect(await db.select({ id: workspaces.id }).from(workspaces)).toEqual([{ id: sourceId }]);
    expect(host.copied).toEqual([]);
  });

  it('is done only by a person, never a workspace key or an agent run, whatever its roles', async () => {
    const asKey = createClient(db, workspaceCaller(sourceId, keyId), { host });
    const asRun = createClient(
      db,
      {
        kind: CALLER_RUN,
        runId: '00000000-0000-4000-8000-000000000001',
        workspaceId: sourceId,
        agentId: MISSING_ID,
        roles: Object.values(AdminRole),
        depth: 1,
      },
      { host },
    );
    for (const caller of [asKey, asRun]) {
      const refused = await caller.expectError(COPY, { fromWorkspaceId: sourceId, slug: 'second-app', name: 'x' });
      expect(refused.code).toBe(ErrorCode.Forbidden);
    }
    expect(await db.select({ id: workspaces.id }).from(workspaces)).toEqual([{ id: sourceId }]);
  });
});
