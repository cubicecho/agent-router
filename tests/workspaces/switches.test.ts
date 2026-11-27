import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runnableAgent } from '../../server/agents/start.ts';
import { AdminRole } from '../../server/core/admin-roles.ts';
import { CALLER_RUN } from '../../server/core/context.ts';
import { WORKSPACE_DEFAULTS } from '../../server/core/defaults.ts';
import { ErrorCode } from '../../server/core/errors.ts';
import { workspaceAgentDisabledServers } from '../../server/db/tables/workspace-agent-disabled-servers.ts';
import { workspaceAgentDisabledTools } from '../../server/db/tables/workspace-agent-disabled-tools.ts';
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

// The per-agent switches: a workspace's server, or one of its tools, turned off for one agent there. Which servers a
// workspace has is the host's, read from its view: these tests put servers in the workspace on the test host.

const CREATE_AGENT = 'mutation ($document: JSON!) { createAgent(document: $document) { id } }';
const OFFER = 'mutation ($v: CreateWorkspaceAgentInput!) { createWorkspaceAgent(values: $v) { id } }';
const SET_SERVER = `mutation ($workspaceAgentId: UUID!, $serverId: UUID!, $enabled: Boolean!) {
  setWorkspaceAgentServerEnabled(workspaceAgentId: $workspaceAgentId, serverId: $serverId, enabled: $enabled)
}`;
const SET_TOOL = `mutation ($workspaceAgentId: UUID!, $serverId: UUID!, $tool: String!, $enabled: Boolean!) {
  setWorkspaceAgentToolEnabled(workspaceAgentId: $workspaceAgentId, serverId: $serverId, tool: $tool, enabled: $enabled)
}`;
const ENTRY = `query ($id: UUID!) {
  workspaceAgent(where: { id: { eq: $id } }) { disabledServers { serverId } disabledTools { serverId tool } }
}`;
const MISSING_ID = '00000000-0000-4000-8000-000000000000';

/** An agent whose document names a server of its own, which the router doesn't read. */
const FINANCE = {
  spec: 'cubicecho.agent/2',
  id: 'personal-finance',
  model: { model: 'fake/m1' },
  prompt: [{ role: 'system', name: 'identity', content: 'You help me run my household money.' }],
  tools: { servers: ['github'] },
};

let db: TestDb;
let host: FakeHost;
let asUser: TestClient;
let workspaceId: string;
let keyId: string;
let agentId: string;
let entryId: string;
let serverIds: Record<'actual' | 'github' | 'elsewhere', string>;

/**
 * Reads the servers the workspace's apps would reach with an agent, from the client's snapshot.
 *
 * @param [name] - The agent.
 * @returns Their names, or null when the workspace may not run it.
 */
async function reached(name = 'personal-finance'): Promise<readonly string[] | null> {
  return runnableAgent((await asUser.snapshot()).current().agents, workspaceId, name)?.servers ?? null;
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(() => closeTestDb(db));

beforeEach(async () => {
  await resetTestDb(db);
  host = new FakeHost();
  asUser = createClient(db, personCaller(), { host });
  serverIds = {
    actual: host.addServer('actual', 'node', []).id,
    github: host.addServer('github', 'node', []).id,
    elsewhere: host.addServer('elsewhere', 'node', []).id,
  };
  ({ workspaceId, keyId } = await createWorkspaceWithKey(db, 'task-server'));
  host.addToWorkspace(workspaceId, serverIds.actual);
  host.addToWorkspace(workspaceId, serverIds.github);
  agentId = (await asUser.expectOk(CREATE_AGENT, { document: FINANCE })).createAgent.id;
  entryId = (await asUser.expectOk(OFFER, { v: { workspaceId, agentId } })).createWorkspaceAgent.id;
  const coderId = (await asUser.expectOk(CREATE_AGENT, { document: { ...FINANCE, id: 'coder' } })).createAgent.id;
  await asUser.expectOk(OFFER, { v: { workspaceId, agentId: coderId } });
});

describe("turning a workspace's server off for one agent", () => {
  it('leaves it out for that agent only, until it is turned on again', async () => {
    expect(await reached()).toEqual(['actual', 'github']);
    const off = { workspaceAgentId: entryId, serverId: serverIds.github, enabled: false };
    expect((await asUser.expectOk(SET_SERVER, off)).setWorkspaceAgentServerEnabled).toBe(false);
    // Turning it off twice is the same as once.
    await asUser.expectOk(SET_SERVER, off);
    expect(await reached()).toEqual(['actual']);
    expect(await reached('coder')).toEqual(['actual', 'github']);
    const { workspaceAgent } = await asUser.expectOk(ENTRY, { id: entryId });
    expect(workspaceAgent.disabledServers).toEqual([{ serverId: serverIds.github }]);

    await asUser.expectOk(SET_SERVER, { ...off, enabled: true });
    expect(await reached()).toEqual(['actual', 'github']);
  });

  it('is refused where the workspace lacks the server or the agent, changing nothing', async () => {
    const notThere = await asUser.expectError(SET_SERVER, {
      workspaceAgentId: entryId,
      serverId: serverIds.elsewhere,
      enabled: false,
    });
    expect(notThere.code).toBe(ErrorCode.NotFound);
    const unknownEntry = await asUser.expectError(SET_SERVER, {
      workspaceAgentId: MISSING_ID,
      serverId: serverIds.actual,
      enabled: false,
    });
    expect(unknownEntry.code).toBe(ErrorCode.NotFound);
    expect(await db.select().from(workspaceAgentDisabledServers)).toEqual([]);
  });

  it('reads the host view now, so a server the host just added can be switched', async () => {
    host.addToWorkspace(workspaceId, serverIds.elsewhere);
    const on = { workspaceAgentId: entryId, serverId: serverIds.elsewhere, enabled: false };
    expect((await asUser.expectOk(SET_SERVER, on)).setWorkspaceAgentServerEnabled).toBe(false);
  });
});

describe("turning one of a workspace server's tools off for one agent", () => {
  it('is stored by the tool’s own name, and turned on again', async () => {
    const off = { workspaceAgentId: entryId, serverId: serverIds.github, tool: 'delete_repo', enabled: false };
    expect((await asUser.expectOk(SET_TOOL, off)).setWorkspaceAgentToolEnabled).toBe(false);
    await asUser.expectOk(SET_TOOL, off);
    const { workspaceAgent } = await asUser.expectOk(ENTRY, { id: entryId });
    expect(workspaceAgent.disabledTools).toEqual([{ serverId: serverIds.github, tool: 'delete_repo' }]);
    const disabled = (await asUser.snapshot()).current().agents.get('personal-finance')?.disabledTools;
    expect([...(disabled?.get(workspaceId)?.get('github') ?? [])]).toEqual(['delete_repo']);

    await asUser.expectOk(SET_TOOL, { ...off, enabled: true });
    expect(await db.select().from(workspaceAgentDisabledTools)).toEqual([]);
  });

  it("can be switched only where the workspace runs the agent and has the server, and by a tool's name", async () => {
    const notInWorkspace = await asUser.expectError(SET_TOOL, {
      workspaceAgentId: entryId,
      serverId: serverIds.elsewhere,
      tool: 'x',
      enabled: false,
    });
    expect(notInWorkspace.code).toBe(ErrorCode.NotFound);
    const unknownEntry = await asUser.expectError(SET_TOOL, {
      workspaceAgentId: MISSING_ID,
      serverId: serverIds.actual,
      tool: 'echo',
      enabled: false,
    });
    expect(unknownEntry.code).toBe(ErrorCode.NotFound);
    for (const tool of ['', 'x'.repeat(WORKSPACE_DEFAULTS.maxToolNameLength + 1)]) {
      const bad = await asUser.expectError(SET_TOOL, {
        workspaceAgentId: entryId,
        serverId: serverIds.actual,
        tool,
        enabled: false,
      });
      expect(bad.code).toBe(ErrorCode.BadUserInput);
    }
    expect(await db.select().from(workspaceAgentDisabledTools)).toEqual([]);
  });
});

describe('the switches', () => {
  it('are switched only by a person, never a workspace key or an agent run, whatever its roles', async () => {
    await asUser.expectOk(SET_SERVER, { workspaceAgentId: entryId, serverId: serverIds.actual, enabled: false });
    const asKey = createClient(db, workspaceCaller(workspaceId, keyId), { host });
    const asRun = createClient(
      db,
      {
        kind: CALLER_RUN,
        runId: '00000000-0000-4000-8000-000000000001',
        workspaceId,
        agentId,
        roles: Object.values(AdminRole),
        depth: 1,
      },
      { host },
    );
    for (const caller of [asKey, asRun]) {
      const server = await caller.expectError(SET_SERVER, {
        workspaceAgentId: entryId,
        serverId: serverIds.actual,
        enabled: true,
      });
      expect(server.code).toBe(ErrorCode.Forbidden);
      const tool = await caller.expectError(SET_TOOL, {
        workspaceAgentId: entryId,
        serverId: serverIds.actual,
        tool: 'echo',
        enabled: false,
      });
      expect(tool.code).toBe(ErrorCode.Forbidden);
    }
    const rows = await db
      .select({ serverId: workspaceAgentDisabledServers.serverId })
      .from(workspaceAgentDisabledServers)
      .where(eq(workspaceAgentDisabledServers.workspaceAgentId, entryId));
    expect(rows).toEqual([{ serverId: serverIds.actual }]);
  });
});
