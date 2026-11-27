import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserCaller } from '../../server/core/context.ts';
import { ErrorCode } from '../../server/core/errors.ts';
import { createSnapshotHost } from '../../server/db/snapshot.ts';
import { FakeHost } from '../fake-host.ts';
import { createClient, personCaller, type TestClient } from '../graphql-client.ts';
import { closeTestDb, createTestDb, createWorkspaceWithKey, resetTestDb, type TestDb } from '../helpers.ts';

// The agents fields of this package's schema: saving through the document check, revisions, and deleting an agent,
// which tells the host. Providers, pools and servers are the test host's.

const CREATE = `mutation ($document: JSON!, $message: String) {
  createAgent(document: $document, message: $message) { id name liveRevisionId }
}`;
const SAVE = `mutation ($id: UUID!, $document: JSON!, $message: String) {
  saveAgent(id: $id, document: $document, message: $message) { id number document warnings message createdBy promotedAt }
}`;
const PROMOTE = 'mutation ($id: UUID!) { promoteRevision(id: $id) { id liveRevisionId } }';
const CHECK = `query ($document: JSON!, $id: UUID) { checkAgent(document: $document, id: $id) { errors warnings } }`;
const HISTORY = `query ($id: UUID!) {
  agent(where: { id: { eq: $id } }) {
    name liveRevisionId
    revisions(orderBy: { number: { direction: asc, priority: 1 } }) { id number message promotedAt createdBy }
  }
}`;

/** A document that names only what the router has. */
const FINANCE = {
  spec: 'cubicecho.agent/2',
  id: 'personal-finance',
  name: 'Personal Finance',
  model: { model: 'ollama/qwen3:32b', temperature: 0.3 },
  prompt: [{ role: 'system', name: 'identity', content: 'You help me run my household money.' }],
  tools: { maxIterations: 20 },
  tasks: { title: { model: 'small' } },
};

let db: TestDb;
let user: UserCaller;
let asUser: TestClient;
let host: FakeHost;

/**
 * Makes the agent through the API.
 *
 * @param [document] - Its first document.
 * @returns Its id and first revision's id.
 */
async function makeAgent(document: Record<string, unknown> = FINANCE): Promise<{ id: string; first: string }> {
  const { createAgent } = await asUser.expectOk(CREATE, { document, message: 'First.' });
  return { id: createAgent.id, first: createAgent.liveRevisionId };
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(() => closeTestDb(db));

beforeEach(async () => {
  await resetTestDb(db);
  host = new FakeHost();
  host.providers.set('ollama', { name: 'ollama', enabled: true });
  host.pools.set('small', { name: 'small', enabled: true, targets: [] });
  host.addServer('actual', 'node', []);
  user = personCaller();
  asUser = createClient(db, user, { host });
});

describe('creating an agent', () => {
  it('names it by the document id and makes the first revision live', async () => {
    const { id, first } = await makeAgent();
    const { agent } = await asUser.expectOk(HISTORY, { id });
    expect(agent).toMatchObject({
      name: 'personal-finance',
      liveRevisionId: first,
    });
    expect(agent.revisions).toEqual([
      {
        id: first,
        number: 1,
        message: 'First.',
        promotedAt: expect.anything(),
        createdBy: user.userId,
      },
    ]);
  });

  it('stores the document as received, unknown keys included', async () => {
    const { id } = await makeAgent({ ...FINANCE, futureField: { kept: true } });
    const { agent } = await asUser.expectOk(
      'query ($id: UUID!) { agent(where: { id: { eq: $id } }) { liveRevision { document warnings } } }',
      { id },
    );
    expect(agent.liveRevision.document).toEqual({ ...FINANCE, futureField: { kept: true } });
  });

  it.each([
    ['no spec token', { id: 'a' }, 'spec'],
    ['another major', { spec: 'cubicecho.agent/3', id: 'a' }, 'spec'],
    ['no id', { spec: 'cubicecho.agent/2' }, 'needs an id'],
    ['an id breaking the name rule', { spec: 'cubicecho.agent/2', id: 'Personal Finance' }, 'id:'],
    [
      'a part named as an app part',
      { ...FINANCE, prompt: [{ role: 'system', name: 'app_lane', content: 'x' }] },
      'app',
    ],
    ['an extension this router does not understand', { ...FINANCE, requires: ['com.example.x'] }, 'requires'],
  ])('refuses a document with %s, saying why', async (_label, document, why) => {
    const refused = await asUser.expectError(CREATE, { document });
    expect(refused.code).toBe(ErrorCode.BadUserInput);
    expect(refused.message).toContain(why);
  });

  it('upgrades a version 1 document and keeps it as version 2, saying so', async () => {
    const old = {
      ...FINANCE,
      spec: 'cubicecho.agent/1',
      prompt: [
        { id: 'identity', text: 'You help me run my household money.' },
        { id: 'rules', ref: { type: 'file', value: './rules.md' } },
      ],
    };
    const { id } = await makeAgent(old);
    const { agent } = await asUser.expectOk(
      'query ($id: UUID!) { agent(where: { id: { eq: $id } }) { liveRevision { document warnings } } }',
      { id },
    );
    expect(agent.liveRevision.document).toEqual(FINANCE);
    expect(agent.liveRevision.warnings.join(' ')).toContain('version 1');
    expect(agent.liveRevision.warnings.join(' ')).toContain('prompt[1]');
  });

  it('refuses a name already taken', async () => {
    await makeAgent();
    expect((await asUser.expectError(CREATE, { document: FINANCE })).message).toContain('already exists');
  });

  it('takes out a bundled server’s env and headers, and warns', async () => {
    const bundled = {
      ...FINANCE,
      bundle: { mcpServers: [{ id: 'notes', command: 'notes-mcp', env: { NOTES_TOKEN: 'planted-bundle-secret' } }] },
    };
    const { id } = await makeAgent(bundled);
    const answer = JSON.stringify(
      await asUser.expectOk(
        'query ($id: UUID!) { agent(where: { id: { eq: $id } }) { liveRevision { document warnings } } }',
        {
          id,
        },
      ),
    );
    expect(answer).not.toContain('planted-bundle-secret');
    expect(answer).toContain("env and headers aren't kept");
  });
});

describe('warnings', () => {
  it('name what the router lacks, without refusing', async () => {
    const { checkAgent } = await asUser.expectOk(CHECK, {
      document: {
        spec: 'cubicecho.agent/2',
        id: 'x',
        model: { model: 'nowhere/m' },
        tasks: { title: { model: 'no-such-pool' } },
      },
    });
    expect(checkAgent.errors).toEqual([]);
    expect(checkAgent.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('no provider is named "nowhere"'),
        expect.stringContaining('no pool is named "no-such-pool"'),
      ]),
    );
  });

  it('say the router ignores a server list, which a workspace decides instead', async () => {
    const { checkAgent } = await asUser.expectOk(CHECK, {
      document: { ...FINANCE, tools: { servers: ['actual'] } },
    });
    expect(checkAgent).toEqual({
      errors: [],
      warnings: [expect.stringContaining('tools.servers: ai-router ignores it')],
    });
  });

  it('are none for a document that names only what the router has', async () => {
    expect((await asUser.expectOk(CHECK, { document: FINANCE })).checkAgent).toEqual({ errors: [], warnings: [] });
  });

  it('say an agent with its own endpoint skips the router’s models', async () => {
    const { checkAgent } = await asUser.expectOk(CHECK, {
      document: { ...FINANCE, endpoint: { baseUrl: 'http://elsewhere/v1' }, model: { model: 'nowhere/m' } },
    });
    expect(checkAgent.warnings).toEqual([expect.stringContaining('calls that address directly')]);
  });
});

describe('revisions', () => {
  it('number each save, make it live, and keep every earlier one', async () => {
    const { id, first } = await makeAgent();
    const { saveAgent } = await asUser.expectOk(SAVE, {
      id,
      document: { ...FINANCE, description: 'Now with bills.' },
      message: 'Bills.',
    });
    expect(saveAgent).toMatchObject({ number: 2, message: 'Bills.', createdBy: user.userId });
    const { agent } = await asUser.expectOk(HISTORY, { id });
    expect(agent.liveRevisionId).toBe(saveAgent.id);
    expect(agent.revisions.map((revision: { id: string }) => revision.id)).toEqual([first, saveAgent.id]);
  });

  it('refuse a document for another agent', async () => {
    const { id } = await makeAgent();
    const { message } = await asUser.expectError(SAVE, { id, document: { ...FINANCE, id: 'coding' } });
    expect(message).toContain('this is agent "personal-finance"');
  });

  it('roll back when an older one is made live again', async () => {
    const { id, first } = await makeAgent();
    await asUser.expectOk(SAVE, { id, document: { ...FINANCE, description: 'Two.' } });
    const { promoteRevision } = await asUser.expectOk(PROMOTE, { id: first });
    expect(promoteRevision).toEqual({ id, liveRevisionId: first });
  });

  it('cannot be written by generated CRUD', async () => {
    for (const field of ['createAgentRevision', 'updateAgentRevision', 'deleteAgentRevision', 'updateAgent']) {
      const { message } = await asUser.expectError(`mutation { ${field} { id } }`);
      expect(message).toContain(`Cannot query field "${field}"`);
    }
  });
});

describe('the snapshot', () => {
  it('holds each agent’s live document and the workspaces that may run it', async () => {
    const snapshot = await createSnapshotHost(db, async () => host.view());
    const { createAgent } = await asUser.expectOk(CREATE, { document: FINANCE });
    const { workspaceId } = await createWorkspaceWithKey(db, 'min-agent');
    await asUser.expectOk('mutation ($v: CreateWorkspaceAgentInput!) { createWorkspaceAgent(values: $v) { id } }', {
      v: { workspaceId, agentId: createAgent.id },
    });
    await snapshot.rebuild();
    const agent = snapshot.current().agents.get('personal-finance');
    expect(agent).toMatchObject({
      liveRevisionId: createAgent.liveRevisionId,
      document: FINANCE,
    });
    // Offered with no servers in the workspace yet, so its runs there reach none.
    expect([...(agent?.workspaces ?? [])]).toEqual([[workspaceId, []]]);
  });
});

describe('deleting an agent', () => {
  const DELETE = 'mutation ($id: UUID!) { deleteAgent(where: { id: { eq: $id } }) { id } }';

  it('takes its revisions and workspace entries, and tells the host once the delete commits', async () => {
    const { id } = await makeAgent();
    await asUser.expectOk(DELETE, { id });
    expect((await asUser.expectOk('{ agentRevisions { id } }')).agentRevisions).toEqual([]);
    expect(host.deleted).toEqual([{ kind: 'agent', id }]);
  });

  it('is done when the host fails to clean up, which is logged', async () => {
    const { id } = await makeAgent();
    host.lifecycleFailure = new Error('the host is down');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await asUser.expectOk(DELETE, { id })).deleteAgent).toEqual({ id });
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('[agent-router]'), 'the host is down');
    } finally {
      logged.mockRestore();
    }
    expect((await asUser.expectOk('{ agents { id } }')).agents).toEqual([]);
  });

  it('never tells the host of a delete that was refused', async () => {
    const { id } = await makeAgent();
    const { workspaceId, keyId } = await createWorkspaceWithKey(db, 'min-agent');
    const asKey = createClient(db, { kind: 'workspace', workspaceId, keyId }, { host });
    expect((await asKey.expectError(DELETE, { id })).code).toBe(ErrorCode.Forbidden);
    expect(host.deleted).toEqual([]);
  });
});

describe('who may', () => {
  it('refuses a workspace key everything', async () => {
    const { workspaceId, keyId } = await createWorkspaceWithKey(db, 'min-agent');
    const asKey = createClient(db, { kind: 'workspace', workspaceId, keyId });
    expect((await asKey.expectError(CREATE, { document: FINANCE })).code).toBe(ErrorCode.Forbidden);
  });
});
