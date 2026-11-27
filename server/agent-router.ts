import type { Runtime } from '@cubicecho/agent-core';
import type { Router } from 'express';
import type { GraphQLSchema } from 'graphql';
import { createAgentMcpRoutes } from './agents/mcp.ts';
import { createAgentRoutes } from './agents/routes.ts';
import { createRunService, type RunService } from './agents/run.ts';
import { createRunRecordRoutes } from './agents/run-records.ts';
import { upgradeStored } from './agents/upgrade.ts';
import type { RunSettings, WorkerSettings } from './core/defaults.ts';
import type { DB } from './db/client.ts';
import { createSnapshotHost, type SnapshotHost } from './db/snapshot.ts';
import { buildAgentRouterSchema } from './graphql/build-schema.ts';
import type { AgentRouterPorts } from './ports.ts';
import { WORKERS_PATH } from './runner/protocol.ts';
import { createWorkerRegistry } from './workers/registry.ts';
import { createRemoteWorkers, type RemoteWorkers } from './workers/remote.ts';
import { createWorkerRoutes } from './workers/routes.ts';

/** What a host hands agent-router to build its parts. */
export interface AgentRouterDeps {
  /** The host's Postgres, with this package's migrations applied. */
  db: DB;
  /** The host's models, tools, routing view and people. */
  ports: AgentRouterPorts;
  /** Run settings that differ from `RUN_DEFAULTS`. */
  overrides?: Partial<RunSettings>;
  /** Worker settings that differ from `WORKER_DEFAULTS`. */
  workerOverrides?: Partial<WorkerSettings>;
  /**
   * agent-core's caches for the runs.
   * @defaultValue a runtime of their own
   */
  runtime?: Runtime;
  /** The clock keys' expiry, retention and waiting are judged by. */
  now?: () => Date;
  /**
   * What the doors route by.
   * @defaultValue one over `db` and `ports.readHostView`, read now
   */
  snapshot?: SnapshotHost;
  /**
   * The remote workers.
   * @defaultValue none online, over a registry of this database's workers, with `workerOverrides`
   */
  workers?: RemoteWorkers;
}

/** The routers a host mounts, each at its path. */
export interface AgentRouterRoutes {
  /** The agents endpoint, at `/v1`: workspace keys only. */
  v1: Router;
  /** The agents as MCP tools, at `/mcp`: workspace keys only. */
  mcp: Router;
  /** Run records, at `/runs`: each key its own workspace's. */
  runs: Router;
  /** The worker doors, at {@link WORKERS_PATH}: worker keys only. */
  workers: Router;
}

/** agent-router's parts, built for one host. */
export interface AgentRouter {
  /** What its doors route by. Rebuild it after a write that changes routing, the host's own included. */
  snapshot: SnapshotHost;
  /** Agent runs, their bus and the remote workers. The host calls `recover`, `start` and `stop` around serving. */
  runs: RunService;
  routes: AgentRouterRoutes;
  /**
   * This package's complete GraphQL schema, permissions applied, for the host to serve or merge with the others'.
   * Its resolvers read an `AgentContext` carrying this snapshot and run service.
   */
  schema: GraphQLSchema;
}

/**
 * Builds agent-router's parts for a host: its snapshot, its run service and its routers.
 *
 * @param deps - The database, the ports, and settings that differ.
 * @returns The parts. Nothing is listening and no timer runs until the host mounts the routes and starts the runs.
 *
 * @remarks
 * Before this, at boot, the host applies `AGENT_ROUTER_MIGRATIONS` and calls {@link upgradeStoredAgents}.
 */
export async function createAgentRouter({
  db,
  ports,
  overrides = {},
  workerOverrides = {},
  runtime,
  now = () => new Date(),
  ...given
}: AgentRouterDeps): Promise<AgentRouter> {
  const snapshot = given.snapshot ?? (await createSnapshotHost(db, ports.readHostView));
  const workers =
    given.workers ??
    createRemoteWorkers(
      createWorkerRegistry(db),
      workerOverrides,
      (workerId) => snapshot.current().workers.get(workerId)?.name ?? workerId,
    );
  const runs = createRunService({
    db,
    snapshot,
    tools: ports.tools,
    workers,
    overrides,
    now,
    ...(runtime === undefined ? {} : { runtime }),
  });
  return {
    snapshot,
    runs,
    schema: buildAgentRouterSchema({ db, ports }),
    routes: {
      v1: createAgentRoutes({ snapshot, runs, models: ports.models, overrides, now }),
      mcp: createAgentMcpRoutes({ db, snapshot, runs, models: ports.models, now }),
      runs: createRunRecordRoutes({ db, snapshot, runs, overrides, now }),
      workers: createWorkerRoutes({ snapshot, workers }),
    },
  };
}

/**
 * Upgrades what this package keeps to agent-core 7, once, at boot: after the migrations, before the snapshot is read.
 *
 * @param db - The database, claimed and migrated.
 */
export async function upgradeStoredAgents(db: DB): Promise<void> {
  await upgradeStored(db);
}

export { ADMIN_ROLES, AdminRole } from './core/admin-roles.ts';
export type { AgentContext } from './core/context.ts';
export { AGENT_ROUTER_MIGRATIONS } from './db/client.ts';
export { abilityFor, abilityForRoles, canReachField, FIELD_GRANTS } from './graphql/abilities.ts';
export { type AgentRouterSchemaDeps, buildAgentRouterSchema } from './graphql/build-schema.ts';
export * from './ports.ts';
export { WORKERS_PATH };
