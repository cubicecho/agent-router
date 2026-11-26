/**
 * What a workspace lets its agent runs do with this package's fields through the host's admin server. Each package
 * declares the roles its own fields need, and the host offers their union. Roles add up, and a manage role includes
 * reading its own area. None reaches promoting, deleting an agent, or workspaces and keys: those stay with people.
 */
export const AdminRole = {
  /** See agents and their revisions. */
  AgentsRead: 'agents:read',
  /** Create agents and save revisions, as drafts unless the agent has auto-promote. */
  AgentsManage: 'agents:manage',
  /** See the runs the agent's own workspace started. */
  RunsRead: 'runs:read',
} as const;
export type AdminRole = (typeof AdminRole)[keyof typeof AdminRole];

/** This package's roles, in the order the host's UI lists them. */
export const ADMIN_ROLES: readonly AdminRole[] = Object.freeze(Object.values(AdminRole));
