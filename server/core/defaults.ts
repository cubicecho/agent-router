// Every value someone might tune, as plain data. Nothing here computes, reads the environment or imports.

/** Workspace keys and worker keys. */
export interface KeySettings {
  /** Random bytes in a new key, before encoding. */
  secretBytes: number;
  /** How many characters of a key, after its prefix, are kept in the clear so a list can tell keys apart. */
  visibleChars: number;
}

export const KEY_DEFAULTS: Readonly<KeySettings> = Object.freeze({
  secretBytes: 32,
  visibleChars: 6,
});

/** Router names: workspace slugs, providers, pools, and later servers and agents. */
export interface NameSettings {
  /** Longest name, in characters. */
  maxLength: number;
}

export const NAME_DEFAULTS: Readonly<NameSettings> = Object.freeze({
  maxLength: 64,
});

/** What an agent's document and its revisions may hold. */
export interface AgentConfigSettings {
  /** The largest document, as JSON, in bytes. */
  maxDocumentBytes: number;
  /** Characters in a revision's message. */
  maxMessageLength: number;
}

export const AGENT_CONFIG_DEFAULTS: Readonly<AgentConfigSettings> = Object.freeze({
  maxDocumentBytes: 262_144,
  maxMessageLength: 500,
});

/** Agent runs on the agents endpoint, and their records. */
export interface RunSettings {
  /** How long one run may take, from its start or resume to its answer, before it fails. Waiting doesn't count. */
  timeoutMinutes: number;
  /** How long a finished run's `Idempotency-Key` keeps answering with that run. After it, the key starts a new one. */
  idempotencyHours: number;
  /** How many days a finished run's record is kept. */
  retentionDays: number;
  /** How often old runs and spent keys are cleared. */
  pruneEveryHours: number;
  /** Largest JSON body /v1 accepts, as `express.json` reads it. A long conversation is bigger than a GraphQL operation. */
  bodyLimit: string;
  /** How often a quiet stream is sent a comment, so a proxy doesn't close it while a tool runs. */
  heartbeatSeconds: number;
  /** Characters in an `Idempotency-Key`. */
  maxIdempotencyKeyLength: number;
  /** Characters in a request's `user`. */
  maxUserLength: number;
  /** Characters of a failure's message kept on the run. */
  maxErrorLength: number;
  /** How long a run's events wait in memory before they are written to `run_events` together. */
  eventFlushMs: number;
  /**
   * How long a stretch of streamed thinking or output still going may wait in memory, so it is stored as one row. A
   * longer one is stored in parts, which readers join again.
   */
  streamHoldMs: number;
  /** Rows written in one insert. */
  eventBatchSize: number;
  /** Events `Run.events` answers with when the query gives no limit. */
  eventPageSize: number;
  /** The most events `Run.events` answers with at once. */
  maxEventPageSize: number;
  /** Runs `GET /runs` and `runSessions` answer with when the request gives no limit. */
  runPageSize: number;
  /** The most runs `GET /runs`, or sessions `runSessions`, answer with at once. */
  maxRunPageSize: number;
  /** The most characters of a session's first message `runSessions` answers as its title. */
  sessionTitleLength: number;
  /**
   * How long a run waits for the app to answer the tool calls it handed back before it expires. Generous, since an
   * app's tool may be a person answering a question.
   */
  waitTimeoutHours: number;
  /** How often waiting runs are checked for that timeout. */
  expireEveryMinutes: number;
  /** How often `/mcp` asks a client to check a task, the run it started, when it polls rather than waits. */
  taskPollIntervalMs: number;
  /**
   * How deep agents may call agents through `/mcp`: a run an app started is 0, and each call to an agent one more.
   * A call past it is refused, so agents calling each other can't run on forever.
   */
  maxAgentDepth: number;
}

export const RUN_DEFAULTS: Readonly<RunSettings> = Object.freeze({
  timeoutMinutes: 30,
  idempotencyHours: 24,
  retentionDays: 30,
  pruneEveryHours: 6,
  bodyLimit: '8mb',
  heartbeatSeconds: 15,
  maxIdempotencyKeyLength: 255,
  maxUserLength: 256,
  maxErrorLength: 2_000,
  eventFlushMs: 250,
  streamHoldMs: 10_000,
  eventBatchSize: 500,
  eventPageSize: 500,
  maxEventPageSize: 5_000,
  runPageSize: 25,
  maxRunPageSize: 100,
  sessionTitleLength: 80,
  waitTimeoutHours: 24,
  expireEveryMinutes: 5,
  taskPollIntervalMs: 2_000,
  maxAgentDepth: 3,
});

/** Remote workers: the processes that dial in with a worker key and run agent loops away from the router. */
export interface WorkerSettings {
  /** How often a worker and the router tell each other they are still there. */
  heartbeatMs: number;
  /** How long a worker that stopped answering may take to dial in again before its runs fail. */
  reconnectGraceMs: number;
  /** The most run events a worker sends in one message. */
  eventBatchSize: number;
  /** How long a worker holds run events before it sends them together. */
  eventFlushMs: number;
  /** The most runs one remote worker runs at once. A run past it is refused as `worker_busy`. */
  maxRunsAtOnce: number;
  /** How long a worker told to cancel a run may take to finish it before the router ends it itself. */
  cancelGraceMs: number;
  /** Largest JSON body the worker doors accept, as `express.json` reads it: a model call carries the transcript. */
  bodyLimit: string;
}

export const WORKER_DEFAULTS: Readonly<WorkerSettings> = Object.freeze({
  heartbeatMs: 15_000,
  reconnectGraceMs: 60_000,
  eventBatchSize: 100,
  eventFlushMs: 250,
  maxRunsAtOnce: 8,
  cancelGraceMs: 10_000,
  bodyLimit: '8mb',
});

/**
 * The router's settings: what an admin changes from the Settings page while the router runs. The `settings` row
 * overrides these member by member, and a member nobody has set keeps its value here.
 */
export interface RouterSettings {
  /** The most tools an app may send with one request on `/v1`. OpenAI's own limit is 128. */
  maxAppTools: number;
  /**
   * Whether an app tool that is one of the agent's own under another server's name is dropped: the same tool name
   * after `__`, and the same input schema. A guess, so it is off unless an admin turns it on.
   */
  pruneAppToolsAcrossServers: boolean;
  /**
   * What a request on `/v1` gets for a field its agent locks (`model.lockedFields`), and for a `stream_options` key
   * other than `include_usage`, which the router doesn't read: `refuse` answers 400 naming it, and `ignore` drops it,
   * runs, and names it in `X-AI-Router-Ignored`.
   */
  unlistedFields: 'refuse' | 'ignore';
}

export const ROUTER_DEFAULTS: Readonly<RouterSettings> = Object.freeze({
  maxAppTools: 128,
  pruneAppToolsAcrossServers: false,
  unlistedFields: 'refuse',
});

/** Conversations an app names with `X-Conversation-Id`, whose history the router keeps. */
export interface ConversationSettings {
  /** How long a conversation is kept after its last request or run, before it is deleted. */
  idleHours: number;
  /** Characters in an `X-Conversation-Id`. */
  maxIdLength: number;
}

export const CONVERSATION_DEFAULTS: Readonly<ConversationSettings> = Object.freeze({
  idleHours: 72,
  maxIdLength: 255,
});
