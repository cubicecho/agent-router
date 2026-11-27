import type { OnWriteConfig, WriteHookPayload } from '@vantreeseba/drizzle-graphql';
import { badInput } from '../core/errors.ts';
import { parseOrThrow } from '../core/validation.ts';
import { rebuildAfterCommit, tellHost, writtenRows } from '../graphql/write-guards.ts';
import type { LifecyclePort } from '../ports.ts';
import { workspaceInput } from './input.ts';

/** What a person is told when a generated write names a workspace's worker. */
const WORKER_BY_ITS_OWN = "Set a workspace's worker with setWorkspaceWorker.";

/**
 * Validates a workspace write. Its worker is set only by `setWorkspaceWorker`, which stores `local` as none.
 *
 * @param payload - The write about to run.
 * @throws BAD_USER_INPUT for a row that breaks the input rules or names a worker.
 */
function checkWorkspace({ args }: WriteHookPayload): void {
  for (const row of writtenRows(args)) {
    if ('workerId' in row) {
      throw badInput(WORKER_BY_ITS_OWN);
    }
    parseOrThrow(workspaceInput, row);
  }
}

/**
 * Builds the validation, lifecycle and snapshot hooks for `workspaces`.
 *
 * @param lifecycle - The host's lifecycle port, told of each workspace deleted once the delete commits, so it drops
 * its server entries, their instances and their secrets.
 * @returns The hooks, by table.
 */
export function workspaceWriteHooks(lifecycle: LifecyclePort): OnWriteConfig {
  /**
   * Tells the host each deleted workspace is gone, then rebuilds the snapshot, once the delete commits.
   *
   * @param payload - The delete that just ran, with the ids it deleted.
   */
  const afterWorkspaceDelete = (payload: WriteHookPayload): void => {
    const ids: string[] = payload.rows.map((row: { id: string }) => row.id);
    payload.onCommit(async () => {
      for (const id of ids) {
        await tellHost('workspaceDeleted', () => lifecycle.workspaceDeleted(id));
      }
    });
    rebuildAfterCommit(payload);
  };
  return {
    workspaces: {
      insert: { before: checkWorkspace, after: rebuildAfterCommit },
      update: { before: checkWorkspace, after: rebuildAfterCommit },
      delete: { after: afterWorkspaceDelete, columns: ['id'] },
    },
  };
}
