import { Actions } from '@vantreeseba/graphql-casl';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_ROLES, AdminRole } from '../../server/core/admin-roles.ts';
import { CALLER_RUN, CALLER_WORKSPACE, type RunCaller } from '../../server/core/context.ts';
import { ErrorCode } from '../../server/core/errors.ts';
import { agents } from '../../server/db/tables/agents.ts';
import { runs } from '../../server/db/tables/runs.ts';
import { workspaceAgents } from '../../server/db/tables/workspace-agents.ts';
import { abilityFor, canReachField, FIELD_GRANTS, Subject } from '../../server/graphql/abilities.ts';
import { createClient, personCaller } from '../graphql-client.ts';
import { closeTestDb, createTestDb, createWorkspaceWithKey, resetTestDb, type TestDb } from '../helpers.ts';

const { read, create, delete: remove } = Actions;

/**
 * Builds the caller an agent run hands the admin server.
 *
 * @param workspaceId - The run's workspace.
 * @param roles - What that workspace's entry grants, every package's.
 * @returns The caller.
 */
function runCaller(workspaceId: string, roles: RunCaller['roles']): RunCaller {
  return { kind: CALLER_RUN, runId: 'run-1', workspaceId, agentId: 'agent-1', roles, depth: 1 };
}

describe('abilityFor', () => {
  const NO_WORKSPACE = 'w';

  it('lets a person do everything, and a workspace key or nobody nothing', () => {
    for (const subject of Object.values(Subject)) {
      expect(abilityFor(personCaller()).can(remove, subject)).toBe(true);
      expect(abilityFor(null).can(read, subject)).toBe(false);
      expect(abilityFor({ kind: CALLER_WORKSPACE, workspaceId: 'w', keyId: 'k' }).can(read, subject)).toBe(false);
    }
  });

  it('gives a run with no roles nothing', () => {
    const ability = abilityFor(runCaller(NO_WORKSPACE, []));
    expect(Object.values(Subject).some((subject) => ability.can(read, subject))).toBe(false);
  });

  it("reads only this package's roles, and ignores another package's", () => {
    const ability = abilityFor(runCaller(NO_WORKSPACE, ['models:manage', 'servers:operate']));
    expect(Object.values(Subject).some((subject) => ability.can(read, subject))).toBe(false);
  });

  it('lets agents:manage add revisions and discard them, never delete an agent', () => {
    const ability = abilityFor(runCaller(NO_WORKSPACE, [AdminRole.AgentsManage]));
    expect(ability.can(create, Subject.Agent)).toBe(true);
    expect(ability.can(create, Subject.AgentRevision)).toBe(true);
    expect(ability.can(remove, Subject.AgentRevision)).toBe(true);
    expect(ability.can(remove, Subject.Agent)).toBe(false);
    expect(ability.can(read, Subject.Run)).toBe(false);
  });

  it('adds roles up', () => {
    const ability = abilityFor(runCaller(NO_WORKSPACE, [AdminRole.AgentsRead, AdminRole.RunsRead, 'models:read']));
    expect(ability.can(read, Subject.Agent)).toBe(true);
    expect(ability.can(read, Subject.Run)).toBe(true);
    expect(ability.can(create, Subject.Agent)).toBe(false);
  });

  it('reaches no root field for people only, whatever the roles', () => {
    const ability = abilityFor(runCaller(NO_WORKSPACE, ADMIN_ROLES));
    for (const field of ['workspaces', 'workspaceKeys', 'workers', 'conversations', 'runSessions']) {
      expect(canReachField(ability, 'Query', field)).toBe(false);
    }
    for (const field of ['promoteRevision', 'deleteAgent', 'createWorkspace', 'copyWorkspace', 'cancelRun']) {
      expect(canReachField(ability, 'Mutation', field)).toBe(false);
    }
    expect(Object.keys(FIELD_GRANTS.Mutation).every((field) => canReachField(ability, 'Mutation', field))).toBe(true);
  });
});

describe('an agent run on the schema', () => {
  let db: TestDb;
  let workspaceId: string;
  let otherWorkspaceId: string;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(() => closeTestDb(db));

  beforeEach(async () => {
    await resetTestDb(db);
    ({ workspaceId } = await createWorkspaceWithKey(db, 'task-server'));
    ({ workspaceId: otherWorkspaceId } = await createWorkspaceWithKey(db, 'min-agent'));
  });

  it('is refused a field its roles do not reach', async () => {
    const client = createClient(db, runCaller(workspaceId, []));
    const { code, message } = await client.expectError('{ agents { id } }');
    expect(code).toBe(ErrorCode.Forbidden);
    expect(message).toContain('roles');
  });

  it('reads what its roles allow, and never what only people do', async () => {
    const client = createClient(db, runCaller(workspaceId, [AdminRole.AgentsRead]));
    await client.expectOk('{ agents { id name } }');
    expect((await client.expectError('{ workspaces { id } }')).message).toContain('Only a person');
    const created = await client.expectError('mutation { createAgent(document: {}) { id } }');
    expect(created.code).toBe(ErrorCode.Forbidden);
  });

  it('cannot walk from an agent into the workspaces that run it', async () => {
    const [agent] = await db.insert(agents).values({ name: 'personal-finance' }).returning();
    await db.insert(workspaceAgents).values({ workspaceId, agentId: agent?.id ?? '' });
    const client = createClient(db, runCaller(workspaceId, [AdminRole.AgentsRead]));
    const answer = await client.run('{ agents { name workspaces { workspaceId } } }');
    expect(answer.errors?.[0]?.extensions?.code).toBe(ErrorCode.Forbidden);
    expect(answer.errors?.[0]?.path).toEqual(['agents', 0, 'workspaces', 0, 'workspaceId']);
  });

  it('reads only the runs its own workspace started', async () => {
    await db.insert(runs).values([
      { workspaceId, workspaceName: 'task-server', agentName: 'a', stream: false },
      { workspaceId: otherWorkspaceId, workspaceName: 'min-agent', agentName: 'a', stream: false },
    ]);
    const client = createClient(db, runCaller(workspaceId, [AdminRole.RunsRead]));
    const { runs: seen } = await client.expectOk('{ runs { workspaceName } }');
    expect(seen).toEqual([{ workspaceName: 'task-server' }]);
  });

  it('is refused a people-only mutation, whatever its roles', async () => {
    const client = createClient(db, runCaller(workspaceId, ADMIN_ROLES));
    const { code, message } = await client.expectError(
      'mutation ($id: UUID!) { deleteWorkspace(where: { id: { eq: $id } }) { id } }',
      { id: workspaceId },
    );
    expect(code).toBe(ErrorCode.Forbidden);
    expect(message).toContain('Only a person');
  });
});
