import { stitchSchemas } from '@graphql-tools/stitch';
import { GraphQLObjectType, GraphQLSchema, GraphQLString, graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAgentRouter } from '../../server/agent-router.ts';
import { AdminRole } from '../../server/core/admin-roles.ts';
import { type AgentContext, CALLER_RUN, type Caller } from '../../server/core/context.ts';
import { ErrorCode } from '../../server/core/errors.ts';
import { createSnapshotHost } from '../../server/db/snapshot.ts';
import { FakeHost } from '../fake-host.ts';
import { personCaller } from '../graphql-client.ts';
import {
  closeTestDb,
  createAgent,
  createTestDb,
  createWorkspaceWithKey,
  resetTestDb,
  type TestDb,
  workspaceCaller,
} from '../helpers.ts';

// A host merges this package's finished schema with its own, as ai-router will: here a stand-in host schema with one
// field, stitched with @graphql-tools/stitch. The merged schema serves both, and this package's permissions travel
// with its fields, since each is executed against the schema that holds it.

/** The host's own context, which carries this package's and more. */
interface HostContext extends AgentContext {
  hostName: string;
}

/** The stand-in host's schema: one field, which reads the host's part of the context. */
const HOST_SCHEMA = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: 'Query',
    fields: {
      hostPing: { type: GraphQLString, resolve: (_parent, _args, ctx: HostContext) => `pong from ${ctx.hostName}` },
    },
  }),
});

let db: TestDb;
let host: FakeHost;
let merged: GraphQLSchema;
let context: (caller: Caller | null) => Promise<HostContext>;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(() => closeTestDb(db));

beforeEach(async () => {
  await resetTestDb(db);
  host = new FakeHost();
  const snapshot = await createSnapshotHost(db, async () => host.view());
  const router = await createAgentRouter({ db, ports: host.ports(), snapshot });
  merged = stitchSchemas({ subschemas: [{ schema: router.schema }, { schema: HOST_SCHEMA }] });
  context = async (caller) => {
    await snapshot.rebuild();
    return { db, snapshot, runs: router.runs, caller, hostName: 'the stand-in' };
  };
});

/**
 * Runs an operation on the merged schema.
 *
 * @param caller - Who calls.
 * @param source - The operation.
 * @returns The result.
 */
async function run(caller: Caller | null, source: string) {
  return graphql({ schema: merged, source, contextValue: await context(caller) });
}

describe("the host's merged schema", () => {
  it("serves this package's fields and the host's, in one operation", async () => {
    await createAgent(db, { spec: 'cubicecho.agent/2', id: 'helper', model: { model: 'fake/m1' } });
    const result = await run(personCaller(), '{ hostPing agents { name } workers { name } }');
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      hostPing: 'pong from the stand-in',
      agents: [{ name: 'helper' }],
      workers: [{ name: 'local' }],
    });
  });

  it("keeps this package's mutations, and their writes", async () => {
    const result = await run(
      personCaller(),
      'mutation { createWorkspace(values: { slug: "min-agent", name: "Min agent" }) { slug } }',
    );
    expect(result.data).toEqual({ createWorkspace: { slug: 'min-agent' } });
  });

  it("keeps this package's permissions: a workspace key is refused, and a run reaches only what its roles allow", async () => {
    const { workspaceId, keyId } = await createWorkspaceWithKey(db, 'task-server');
    const asKey = await run(workspaceCaller(workspaceId, keyId), '{ workspaces { id } }');
    expect(asKey.errors?.[0]?.extensions?.code).toBe(ErrorCode.Forbidden);

    const asRun: Caller = {
      kind: CALLER_RUN,
      runId: 'run-1',
      workspaceId,
      agentId: 'agent-1',
      roles: [AdminRole.AgentsRead, 'models:read'],
      depth: 1,
    };
    expect((await run(asRun, '{ agents { id } }')).errors).toBeUndefined();
    const runs = await run(asRun, '{ runs { id } }');
    expect(runs.errors?.[0]?.extensions?.code).toBe(ErrorCode.Forbidden);
    const copied = await run(
      asRun,
      `mutation { copyWorkspace(fromWorkspaceId: "${workspaceId}", slug: "copy", name: "Copy") { id } }`,
    );
    expect(copied.errors?.[0]?.message).toContain('Only a person');
  });

  it('refuses nobody, on this package’s fields', async () => {
    const result = await run(null, '{ workspaces { id } }');
    expect(result.errors?.[0]?.extensions?.code).toBe(ErrorCode.Unauthenticated);
  });
});
