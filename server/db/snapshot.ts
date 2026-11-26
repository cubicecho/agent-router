import { eq } from 'drizzle-orm';
import { ROUTER_DEFAULTS, type RouterSettings } from '../core/defaults.ts';
import type { HostPool, HostProvider, HostServer, HostView } from '../ports.ts';
import type { DB } from './client.ts';
import { agentRevisions } from './tables/agent-revisions.ts';
import { agents } from './tables/agents.ts';
import { workers } from './tables/workers.ts';
import { workspaceAgentDisabledServers } from './tables/workspace-agent-disabled-servers.ts';
import { workspaceAgentDisabledTools } from './tables/workspace-agent-disabled-tools.ts';
import { workspaceAgents } from './tables/workspace-agents.ts';
import { workspaceKeys } from './tables/workspace-keys.ts';
import { workspaces } from './tables/workspaces.ts';

/** A workspace as the gateways see it. */
export interface SnapshotWorkspace {
  id: string;
  slug: string;
  name: string;
  /** The worker its agent loops run on. null for `local`, inside the router. */
  workerId: string | null;
}

/** A worker as the gateways see it. */
export interface SnapshotWorker {
  id: string;
  name: string;
}

/** A worker key as the worker doors see it, found by its hash. */
export interface SnapshotWorkerKey {
  workerId: string;
}

/** A workspace key as the gateways see it, found by its hash. */
export interface SnapshotKey {
  keyId: string;
  workspaceId: string;
  /** null for a key that never expires. */
  expiresAt: Date | null;
}

/** A provider, from the host's view. */
export type SnapshotProvider = HostProvider;
/** A pool, from the host's view. */
export type SnapshotPool = HostPool;
/** A server, from the host's view. */
export type SnapshotServer = HostServer;

/** An agent as a run sees it: its live document and who may run it. */
export interface SnapshotAgent {
  id: string;
  name: string;
  /** null for an agent with no live revision, which cannot run. */
  liveRevisionId: string | null;
  /** The live revision's document, as stored. null with no live revision. */
  document: Readonly<Record<string, unknown>> | null;
  /**
   * The workspaces whose apps may run it, each with the servers it reaches there, by name: the workspace's servers,
   * less those turned off for it, and none when the list is empty. The agent's own `tools.servers` is not read.
   */
  workspaces: ReadonlyMap<string, readonly string[]>;
  /**
   * By workspace id, then by server name: the tools turned off for it there, by each tool's own name on its server.
   * Only read for a server it reaches, so a server turned off keeps its choices for when it is turned on again.
   */
  disabledTools: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>;
}

/** Everything requests route by, read once and held in memory: this package's rows, and the host's view. */
export interface Snapshot {
  /** By id. */
  workspaces: ReadonlyMap<string, SnapshotWorkspace>;
  /** By the key's SHA-256, in hex. */
  keys: ReadonlyMap<string, SnapshotKey>;
  /** By id, `local` included. */
  workers: ReadonlyMap<string, SnapshotWorker>;
  /** By the worker key's SHA-256, in hex. `local` has none. */
  workerKeys: ReadonlyMap<string, SnapshotWorkerKey>;
  /** By name, as a model id names them. From the host. */
  providers: ReadonlyMap<string, SnapshotProvider>;
  /** By name, as a model id names them. From the host. */
  pools: ReadonlyMap<string, SnapshotPool>;
  /** By name, as a tool's name starts. From the host. */
  servers: ReadonlyMap<string, SnapshotServer>;
  /** By name, as an app picks one for its model. */
  agents: ReadonlyMap<string, SnapshotAgent>;
  /** The router's settings in force. From the host. */
  settings: Readonly<RouterSettings>;
}

/** A snapshot with nothing in it. */
export const EMPTY_SNAPSHOT: Snapshot = Object.freeze({
  workspaces: new Map(),
  keys: new Map(),
  workers: new Map(),
  workerKeys: new Map(),
  providers: new Map(),
  pools: new Map(),
  servers: new Map(),
  agents: new Map(),
  settings: ROUTER_DEFAULTS,
});

/** Holds the current snapshot, and builds a new one after a write. */
export interface SnapshotHost {
  /** The snapshot to route this request by. */
  current: () => Snapshot;
  /**
   * Reads everything again: this package's tables and the host's view. Call it after the write's transaction commits,
   * the host's own writes that change its view included.
   *
   * @remarks
   * Calls that arrive while a read is waiting to start share it. A call during a read queues one more,
   * so every committed write is seen. A failed read keeps the old snapshot and rejects.
   */
  rebuild: () => Promise<void>;
}

/** Reads the host's view, for a snapshot. */
export type ReadHostView = () => Promise<HostView>;

/**
 * Reads the snapshot: this package's rows from the database, and the host's view.
 *
 * @param db - The database.
 * @param readHostView - Reads the host's providers, pools, servers, workspace servers and settings.
 * @returns A new snapshot.
 */
export async function loadSnapshot(db: DB, readHostView: ReadHostView): Promise<Snapshot> {
  const [workspaceRows, keyRows, workerRows, agentRows, offerRows, disabledServerRows, disabledToolRows, host] =
    await Promise.all([
      db
        .select({ id: workspaces.id, slug: workspaces.slug, name: workspaces.name, workerId: workspaces.workerId })
        .from(workspaces),
      db
        .select({
          keyId: workspaceKeys.id,
          workspaceId: workspaceKeys.workspaceId,
          hash: workspaceKeys.hash,
          expiresAt: workspaceKeys.expiresAt,
        })
        .from(workspaceKeys),
      db.select({ id: workers.id, name: workers.name, keyHash: workers.keyHash }).from(workers),
      db
        .select({
          id: agents.id,
          name: agents.name,
          liveRevisionId: agents.liveRevisionId,
          document: agentRevisions.document,
        })
        .from(agents)
        .leftJoin(agentRevisions, eq(agentRevisions.id, agents.liveRevisionId)),
      db
        .select({ id: workspaceAgents.id, workspaceId: workspaceAgents.workspaceId, agentId: workspaceAgents.agentId })
        .from(workspaceAgents),
      db
        .select({
          workspaceAgentId: workspaceAgentDisabledServers.workspaceAgentId,
          serverId: workspaceAgentDisabledServers.serverId,
        })
        .from(workspaceAgentDisabledServers),
      db
        .select({
          workspaceAgentId: workspaceAgentDisabledTools.workspaceAgentId,
          serverId: workspaceAgentDisabledTools.serverId,
          tool: workspaceAgentDisabledTools.tool,
        })
        .from(workspaceAgentDisabledTools),
      readHostView(),
    ]);
  const serverNames = new Map([...host.servers.values()].map((server) => [server.id, server.name]));
  const disabled = new Set(disabledServerRows.map((row) => `${row.workspaceAgentId}/${row.serverId}`));
  /** The names of the servers an agent reaches in a workspace, sorted: the workspace's, less those turned off for it. */
  const serverNamesOf = (offer: { id: string; workspaceId: string }): string[] =>
    (host.workspaceServers.get(offer.workspaceId) ?? [])
      .flatMap((serverId) =>
        disabled.has(`${offer.id}/${serverId}`) === false ? (serverNames.get(serverId) ?? []) : [],
      )
      .sort();
  /** The tools turned off for an agent in a workspace, by server name. */
  const disabledToolsOf = (offerId: string): Map<string, Set<string>> => {
    const byServer = new Map<string, Set<string>>();
    for (const row of disabledToolRows) {
      const serverName = serverNames.get(row.serverId);
      if (row.workspaceAgentId === offerId && serverName !== undefined) {
        byServer.set(serverName, (byServer.get(serverName) ?? new Set()).add(row.tool));
      }
    }
    return byServer;
  };
  return {
    settings: host.settings,
    servers: host.servers,
    providers: host.providers,
    pools: host.pools,
    agents: new Map(
      agentRows.map((row) => {
        const offers = offerRows.filter((offer) => offer.agentId === row.id);
        const reached = new Map(offers.map((offer) => [offer.workspaceId, serverNamesOf(offer)] as const));
        const disabledTools = new Map(offers.map((offer) => [offer.workspaceId, disabledToolsOf(offer.id)] as const));
        const agent: SnapshotAgent = {
          id: row.id,
          name: row.name,
          liveRevisionId: row.liveRevisionId,
          document: row.document,
          workspaces: reached,
          disabledTools,
        };
        return [row.name, agent] as const;
      }),
    ),
    workspaces: new Map(workspaceRows.map((row) => [row.id, row])),
    keys: new Map(keyRows.map(({ hash, ...key }) => [hash, key])),
    workers: new Map(workerRows.map(({ id, name }) => [id, { id, name }])),
    workerKeys: new Map(
      workerRows.flatMap(({ id, keyHash }) => (keyHash === null ? [] : [[keyHash, { workerId: id }] as const])),
    ),
  };
}

/**
 * Builds the snapshot host, with its first snapshot read.
 *
 * @param db - The database. This package's migrations must have run.
 * @param readHostView - Reads the host's view, for every snapshot.
 * @returns The host.
 */
export async function createSnapshotHost(db: DB, readHostView: ReadHostView): Promise<SnapshotHost> {
  let snapshot = await loadSnapshot(db, readHostView);
  let latest: Promise<void> = Promise.resolve();
  let waiting: Promise<void> | null = null;
  return {
    current: () => snapshot,
    rebuild: () => {
      if (waiting !== null) {
        return waiting;
      }
      const next = latest
        .catch(() => {})
        .then(async () => {
          // From here on, a new write needs a read of its own.
          waiting = null;
          snapshot = await loadSnapshot(db, readHostView);
        });
      waiting = next;
      latest = next;
      return next;
    },
  };
}
