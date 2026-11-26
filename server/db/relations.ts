import { defineRelations } from 'drizzle-orm';
import * as schema from './schema.ts';

/**
 * Drizzle v2 relations among this package's own tables. drizzle-graphql generates nested read fields from these.
 * Relations to the host's tables (a revision's creator, a workspace's servers) are the host's to add.
 */
export const relations = defineRelations(schema, (relate) => ({
  workspaces: {
    keys: relate.many.workspaceKeys(),
    agents: relate.many.workspaceAgents(),
    runs: relate.many.runs(),
    conversations: relate.many.conversations(),
    worker: relate.one.workers({ from: relate.workspaces.workerId, to: relate.workers.id }),
  },
  workers: {
    workspaces: relate.many.workspaces(),
    runs: relate.many.runs(),
  },
  workspaceKeys: {
    workspace: relate.one.workspaces({ from: relate.workspaceKeys.workspaceId, to: relate.workspaces.id }),
  },
  agents: {
    // Stated, since a revision names an agent twice: the one it is of, and the one whose run saved it.
    revisions: relate.many.agentRevisions({ from: relate.agents.id, to: relate.agentRevisions.agentId }),
    liveRevision: relate.one.agentRevisions({ from: relate.agents.liveRevisionId, to: relate.agentRevisions.id }),
    workspaces: relate.many.workspaceAgents(),
    runs: relate.many.runs(),
  },
  agentRevisions: {
    agent: relate.one.agents({ from: relate.agentRevisions.agentId, to: relate.agents.id }),
    savedByWorkspace: relate.one.workspaces({
      from: relate.agentRevisions.savedByWorkspaceId,
      to: relate.workspaces.id,
    }),
    savedByAgent: relate.one.agents({ from: relate.agentRevisions.savedByAgentId, to: relate.agents.id }),
    basedOn: relate.one.agentRevisions({ from: relate.agentRevisions.basedOnId, to: relate.agentRevisions.id }),
  },
  workspaceAgents: {
    workspace: relate.one.workspaces({ from: relate.workspaceAgents.workspaceId, to: relate.workspaces.id }),
    agent: relate.one.agents({ from: relate.workspaceAgents.agentId, to: relate.agents.id }),
    disabledServers: relate.many.workspaceAgentDisabledServers(),
    disabledTools: relate.many.workspaceAgentDisabledTools(),
  },
  workspaceAgentDisabledServers: {
    workspaceAgent: relate.one.workspaceAgents({
      from: relate.workspaceAgentDisabledServers.workspaceAgentId,
      to: relate.workspaceAgents.id,
    }),
  },
  workspaceAgentDisabledTools: {
    workspaceAgent: relate.one.workspaceAgents({
      from: relate.workspaceAgentDisabledTools.workspaceAgentId,
      to: relate.workspaceAgents.id,
    }),
  },
  runs: {
    workspace: relate.one.workspaces({ from: relate.runs.workspaceId, to: relate.workspaces.id }),
    agent: relate.one.agents({ from: relate.runs.agentId, to: relate.agents.id }),
    revision: relate.one.agentRevisions({ from: relate.runs.revisionId, to: relate.agentRevisions.id }),
    conversation: relate.one.conversations({ from: relate.runs.conversationId, to: relate.conversations.id }),
    worker: relate.one.workers({ from: relate.runs.workerId, to: relate.workers.id }),
  },
  conversations: {
    workspace: relate.one.workspaces({ from: relate.conversations.workspaceId, to: relate.workspaces.id }),
    agent: relate.one.agents({ from: relate.conversations.agentId, to: relate.agents.id }),
    runs: relate.many.runs(),
  },
}));
