import type { OnWriteConfig, WriteHookPayload } from '@vantreeseba/drizzle-graphql';
import { rebuildAfterCommit, tellHost } from '../graphql/write-guards.ts';
import type { LifecyclePort } from '../ports.ts';

/**
 * Builds the hooks for the agents tables CRUD writes: deleting an agent, and which workspaces may run which. An agent
 * is created and saved by `createAgent` and `saveAgent`.
 *
 * @param lifecycle - The host's lifecycle port, told of each agent deleted once the delete commits.
 * @returns The hooks, by table.
 */
export function agentWriteHooks(lifecycle: LifecyclePort): OnWriteConfig {
  /**
   * Tells the host each deleted agent is gone, then rebuilds the snapshot, once the delete commits.
   *
   * @param payload - The delete that just ran, with the ids it deleted.
   */
  const afterAgentDelete = (payload: WriteHookPayload): void => {
    const ids: string[] = payload.rows.map((row: { id: string }) => row.id);
    payload.onCommit(async () => {
      for (const id of ids) {
        await tellHost('agentDeleted', () => lifecycle.agentDeleted(id));
      }
    });
    rebuildAfterCommit(payload);
  };
  return {
    agents: {
      delete: { after: afterAgentDelete, columns: ['id'] },
    },
    workspaceAgents: {
      insert: { after: rebuildAfterCommit },
      update: { after: rebuildAfterCommit },
      delete: { after: rebuildAfterCommit },
    },
  };
}
