/**
 * The worker program as a library: what a program needs to run a worker with its own loop in place of agent-core's.
 *
 * @remarks
 * `startWorker`'s `runtime` is the loop each assignment runs on. `executeRun` and the assignment's types are here so
 * such a loop can be tested on a run as the worker hands it one.
 */

export type {
  AppToolDefinition,
  RunAssignment,
  RunOutcome,
  RunPorts,
  ToolDefinition,
  ToolTarget,
  TranscriptMessage,
} from '../server/runner/assignment.ts';
export { TOOL_ORIGIN_LOCAL, TOOL_ORIGIN_ROUTER } from '../server/runner/assignment.ts';
export { executeRun } from '../server/runner/execute.ts';
export { readWorkerConfig, type WorkerConfig, WorkerConfigError } from './config.ts';
export { type RunningWorker, startWorker, type WorkerDeps } from './worker.ts';
