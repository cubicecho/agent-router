import { ROUTER_DEFAULTS, type RouterSettings } from './core/defaults.ts';
import type { ToolServices } from './tools/api.ts';

// What a host hands agent-router: its models, its tools, the parts of its routing state agents read, and who a
// person is. Each is as narrow as agent-router's code uses it, and shaped so ai-router's own areas already are one.

/** Who a run's model calls count under, as the host's usage records them. */
export interface Attribution {
  /** null for a call no workspace made. */
  workspaceId: string | null;
  workspaceName: string | null;
  /** null for a call no agent made. */
  agentId: string | null;
  agentName: string | null;
}

/** The host's models area, as agent runs use it. */
export interface ModelsPort {
  /**
   * Builds the `fetch` a run's endpoint uses. It answers `MODELS_BASE_URL` (`core/wire.ts`) itself, in process:
   * pools, providers' keys, streaming, and usage under the attribution.
   *
   * @param attribution - Who the run's calls count under.
   * @returns A `fetch` for the run.
   */
  fetchFor(attribution: Attribution): typeof globalThis.fetch;
  /**
   * Reads the context window a provider lists for one of its models, for an agent's `/v1/models` entry.
   *
   * @param providerName - The provider, as a model id names it.
   * @param model - The model's id at the provider.
   * @returns Its window in tokens, or null when the provider is unknown or off, its listing is late, or it states none.
   */
  contextLengthOf(providerName: string, model: string): Promise<number | null>;
}

/** A provider, as an agent's document is checked against it. */
export interface HostProvider {
  name: string;
  enabled: boolean;
}

/** One place a pool can send a call. */
export interface HostPoolTarget {
  /** The provider's name, as `providers` is keyed. */
  providerName: string;
  /** The model's id at the provider. */
  model: string;
}

/** A pool, as an agent's document and context length see it. */
export interface HostPool {
  name: string;
  enabled: boolean;
  /** In the pool's order. */
  targets: readonly HostPoolTarget[];
}

/** One of the host's MCP servers, as an agent's reach sees it. */
export interface HostServer {
  id: string;
  name: string;
  enabled: boolean;
}

/**
 * The host's routing state that agents read, taken into each snapshot this package builds. Read again on every
 * rebuild, so the host rebuilds the snapshot after a write of its own that changes any of it.
 */
export interface HostView {
  /** By name, as a model id names them. */
  providers: ReadonlyMap<string, HostProvider>;
  /** By name, as a model id names them. */
  pools: ReadonlyMap<string, HostPool>;
  /** By name, as a tool's name starts. */
  servers: ReadonlyMap<string, HostServer>;
  /** By workspace id: the ids of the servers in it, which every agent there reaches unless one is turned off for it. */
  workspaceServers: ReadonlyMap<string, readonly string[]>;
  /** The router's settings in force: the defaults, with what an admin saved over them. */
  settings: Readonly<RouterSettings>;
}

/** A person's role, as the host's users carry it. */
export const Role = { Admin: 'admin', User: 'user' } as const;
export type Role = (typeof Role)[keyof typeof Role];

/** A person signed in to the host, as a session shows them. */
export interface SessionUser {
  userId: string;
  role: Role;
}

/** The host's people: sign-in lives there, and agent-router only asks who a request's session is. */
export interface PeoplePort {
  /**
   * Reads the person a request's session token is for.
   *
   * @param headers - The request's headers.
   * @returns The person, or null for no live session.
   */
  sessionUser(headers: Headers): Promise<SessionUser | null>;
}

/**
 * Told when agent-router has deleted a row the host may hang rows of its own off, so the host cleans those up in
 * code: no foreign key crosses packages. Each is called after the delete's transaction commits, beside the snapshot
 * rebuild, and a failure is logged, never undoing the delete.
 */
export interface LifecyclePort {
  /**
   * A workspace is gone, with its keys, its agents' places and their switches. The host drops its server entries,
   * their secrets, and anything else it keyed by the workspace.
   *
   * @param workspaceId - The workspace.
   */
  workspaceDeleted(workspaceId: string): Promise<void>;
  /**
   * An agent is gone, with its revisions. The host drops or detaches what it keyed by the agent, such as usage.
   *
   * @param agentId - The agent.
   */
  agentDeleted(agentId: string): Promise<void>;
  /**
   * A remote worker is gone.
   *
   * @param workerId - The worker.
   */
  workerDeleted(workerId: string): Promise<void>;
}

/** Everything a host hands agent-router. */
export interface AgentRouterPorts {
  models: ModelsPort;
  tools: ToolServices;
  /** Reads the host's view, for each snapshot. */
  readHostView(): Promise<HostView>;
  people: PeoplePort;
  lifecycle: LifecyclePort;
}

/** A host view with nothing in it, and the default settings. */
export const EMPTY_HOST_VIEW: HostView = Object.freeze({
  providers: new Map(),
  pools: new Map(),
  servers: new Map(),
  workspaceServers: new Map(),
  settings: ROUTER_DEFAULTS,
});
