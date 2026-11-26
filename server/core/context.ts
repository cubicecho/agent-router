import type { RunService } from '../agents/run.ts';
import type { DB } from '../db/client.ts';
import type { SnapshotHost } from '../db/snapshot.ts';
import type { Role } from '../ports.ts';

/** A person, on a session. */
export const CALLER_USER = 'user' as const;
/** An app, on a workspace key. */
export const CALLER_WORKSPACE = 'workspace' as const;
/** An agent run, calling the admin server on its workspace's behalf. */
export const CALLER_RUN = 'run' as const;
/** A remote worker, on a worker key. */
export const CALLER_WORKER = 'worker' as const;

/** A person signed in to the host. Sees everything enabled; only an admin sees secrets, settings and roles. */
export interface UserCaller {
  kind: typeof CALLER_USER;
  userId: string;
  role: Role;
}

/** An app calling with a workspace key. Sees what its workspace grants, and never /graphql. */
export interface WorkspaceCaller {
  kind: typeof CALLER_WORKSPACE;
  workspaceId: string;
  keyId: string;
}

/**
 * An agent run calling the admin server. It does what its workspace's entry for the admin server grants, and nothing
 * else. Handed over in process by the run itself, never read from a credential, so it can't be forged.
 */
export interface RunCaller {
  kind: typeof CALLER_RUN;
  runId: string;
  workspaceId: string;
  /** The agent the run is of, so it can discard the drafts it saved and no others. */
  agentId: string;
  /**
   * The roles the workspace's entry for the admin server grants, every package's: this package reads only its own
   * (`AdminRole` in `admin-roles.ts`). Empty grants nothing.
   */
  roles: readonly string[];
  /** The depth an agent a tool call it makes would start is at, as the run's own calls carry it. */
  depth: number;
}

/** Who a request is from, read once from its credential, or handed over by a run. */
export type Caller = UserCaller | WorkspaceCaller | RunCaller;

/**
 * A remote worker calling with its worker key. Read only by the worker doors, so it is never a {@link Caller}: no
 * door for apps or people accepts one.
 */
export interface WorkerCaller {
  kind: typeof CALLER_WORKER;
  workerId: string;
  /** The worker's name, for logs. */
  name: string;
}

/**
 * What this package's GraphQL resolvers (step 4) read from a request's context. A host's own context carries this
 * and more, so it is one as it is.
 */
export interface AgentContext {
  db: DB;
  /** What keys are checked against, and runs route by. */
  snapshot: SnapshotHost;
  /** Agent runs, and the bus their live events are on. */
  runs: RunService;
  /** null for nobody, which permissions refuse. */
  caller: Caller | null;
}
