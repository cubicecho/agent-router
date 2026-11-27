// A program that uses the published worker package, as an installed dependency: CI's worker-package job copies this
// folder into an empty project, installs the tarball beside agent-core, type-checks this file against the package's
// declarations and runs it on the oldest Node the package names. Not part of the repo's own tsconfig or tests.

import { runAgentLoop } from '@cubicecho/agent-core';
import {
  executeRun,
  type RunAssignment,
  type RunningWorker,
  type RunOutcome,
  type RunPorts,
  readWorkerConfig,
  startWorker,
  TOOL_ORIGIN_ROUTER,
  WorkerConfigError,
} from '@cubicecho/agent-router-worker';

/** Starts a worker with agent-core's loop, as a program with its own loop would with that one. */
export const start = (env: NodeJS.ProcessEnv): Promise<RunningWorker> =>
  startWorker(readWorkerConfig(env), { runtime: { runAgentLoop } });

/** Runs one assignment on agent-core's loop, as a program's test of its own loop would. */
export const runOnce = (assignment: RunAssignment, ports: RunPorts): Promise<RunOutcome> =>
  executeRun(assignment, ports, { runAgentLoop });

const exported = [startWorker, readWorkerConfig, executeRun];
if (exported.some((value) => typeof value !== 'function') || typeof TOOL_ORIGIN_ROUTER !== 'string') {
  throw new Error('The worker package is missing part of its library.');
}
try {
  readWorkerConfig({});
  throw new Error('The worker package read a config with no router address.');
} catch (error) {
  if (error instanceof WorkerConfigError === false) {
    throw error;
  }
}
console.log('[consumer] the worker package imports, and refuses a config with no router address');
