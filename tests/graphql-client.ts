import { randomUUID } from 'node:crypto';
import { type ExecutionResult, type GraphQLSchema, graphql, parse, subscribe } from 'graphql';
import { createAgentRouter } from '../server/agent-router.ts';
import type { RunService } from '../server/agents/run.ts';
import { type AgentContext, CALLER_USER, type Caller, type UserCaller } from '../server/core/context.ts';
import { createSnapshotHost, type SnapshotHost } from '../server/db/snapshot.ts';
import { Role } from '../server/ports.ts';
import { FakeHost } from './fake-host.ts';
import type { TestDb } from './helpers.ts';

// Runs operations against this package's schema as a host serves it: an AgentContext over the test database, a
// snapshot over the test host's view, and the run service, with the caller a test picks.

/** What a client runs against, built once per test host. */
interface Served {
  schema: GraphQLSchema;
  runs: RunService;
  snapshot: SnapshotHost;
}

/** Each test host's schema and services. */
const served = new WeakMap<FakeHost, Promise<Served>>();

/** What a client may be given in place of its defaults. */
export interface ClientDeps {
  /** @defaultValue a host of its own, with nothing in it */
  host?: FakeHost;
  /** @defaultValue one over the host's view, read again before every operation */
  snapshot?: SnapshotHost;
  /** @defaultValue a run service of the host's own, which has started no run */
  runs?: RunService;
}

/** The first error of a refused operation. */
export interface RefusedOperation {
  message: string;
  /** `extensions.code`, to compare with `ErrorCode`. */
  code: unknown;
  extensions: Record<string, unknown>;
}

/** Runs operations as one caller. */
export interface TestClient {
  /** The host the client's schema was built over. */
  host: FakeHost;
  /** The snapshot the client's resolvers rebuild, read again before every operation. */
  snapshot: () => Promise<SnapshotHost>;
  /** Executes an operation and returns the raw result. */
  run: (query: string, variables?: Record<string, unknown>) => Promise<ExecutionResult>;
  /** Subscribes, as a host's handler does: the events, or the result that refused it. */
  follow: (
    query: string,
    variables?: Record<string, unknown>,
  ) => Promise<AsyncGenerator<ExecutionResult> | ExecutionResult>;
  /** Runs and returns `data`. Throws the first error's original cause, so a failure reads as the real bug. */
  // biome-ignore lint/suspicious/noExplicitAny: each test reads the fields its own query asked for
  expectOk: (query: string, variables?: Record<string, unknown>) => Promise<any>;
  /** Runs and returns the first error. Throws on success. */
  expectError: (query: string, variables?: Record<string, unknown>) => Promise<RefusedOperation>;
}

/**
 * Builds what a host serves, once per test host.
 *
 * @param db - The test database.
 * @param host - The test host.
 * @returns The schema, the run service and the snapshot.
 */
function servedOf(db: TestDb, host: FakeHost): Promise<Served> {
  const known = served.get(host);
  if (known !== undefined) {
    return known;
  }
  const building = (async () => {
    const snapshot = await createSnapshotHost(db, async () => host.view());
    const router = await createAgentRouter({ db, ports: host.ports(), snapshot });
    return { schema: router.schema, runs: router.runs, snapshot };
  })();
  served.set(host, building);
  return building;
}

/**
 * Makes a person's caller. People are the host's, so the id is any UUID.
 *
 * @param [role] - Their role.
 * @returns The caller.
 */
export function personCaller(role: Role = Role.User): UserCaller {
  return { kind: CALLER_USER, userId: randomUUID(), role };
}

/**
 * Makes a client that runs operations as one caller.
 *
 * @param db - The test database.
 * @param caller - Who calls, or null for nobody.
 * @param [deps] - The test host.
 * @returns The client.
 */
export function createClient(db: TestDb, caller: Caller | null, deps: ClientDeps = {}): TestClient {
  const host = deps.host ?? new FakeHost();

  const context = async (): Promise<AgentContext> => {
    const built = await servedOf(db, host);
    const snapshot = deps.snapshot ?? built.snapshot;
    await snapshot.rebuild();
    return { db, snapshot, runs: deps.runs ?? built.runs, caller };
  };

  const run: TestClient['run'] = async (query, variables) => {
    const { schema } = await servedOf(db, host);
    return graphql({ schema, source: query, contextValue: await context(), variableValues: variables });
  };

  return {
    host,
    snapshot: async () => deps.snapshot ?? (await servedOf(db, host)).snapshot,
    run,
    follow: async (query, variables) => {
      const { schema } = await servedOf(db, host);
      return subscribe({ schema, document: parse(query), contextValue: await context(), variableValues: variables });
    },
    expectOk: async (query, variables) => {
      const result = await run(query, variables);
      const [first] = result.errors ?? [];
      if (first !== undefined) {
        throw first.originalError ?? first;
      }
      return result.data;
    },
    expectError: async (query, variables) => {
      const result = await run(query, variables);
      const [error] = result.errors ?? [];
      if (error === undefined) {
        throw new Error('Expected an error, got a successful result.');
      }
      return { message: error.message, code: error.extensions.code, extensions: error.extensions };
    },
  };
}
