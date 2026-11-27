import { type Action, Actions, createGraphQLAbility, type GraphQLAbility } from '@vantreeseba/graphql-casl';
import { ADMIN_ROLES, AdminRole } from '../core/admin-roles.ts';
import { CALLER_RUN, CALLER_USER, type Caller } from '../core/context.ts';

/** What the abilities talk about: the GraphQL types this package's admin-server roles reach. */
export const Subject = {
  Agent: 'Agent',
  AgentRevision: 'AgentRevision',
  Run: 'Run',
} as const;
export type Subject = (typeof Subject)[keyof typeof Subject];

/** The subject map the ability is typed by. Checks are on bare subjects, with no conditions. */
type Subjects = Record<Subject, Record<string, unknown>>;

/** A caller's ability over this package's subjects. */
export type AgentRouterAbility = GraphQLAbility<Subjects>;

/** What one role grants: actions on subjects. Listed, never casl's `manage`, so a new action is shut until named. */
type Grant = readonly [readonly Action[], readonly Subject[]];

const { read, create, update, delete: remove } = Actions;
const EVERY_ACTION: readonly Action[] = [read, create, update, remove];

/** What each of this package's roles grants. A manage role reads its own area. */
const ROLE_GRANTS: Readonly<Record<AdminRole, readonly Grant[]>> = {
  [AdminRole.AgentsRead]: [[[read], [Subject.Agent, Subject.AgentRevision]]],
  // Delete is a draft's discard, which the resolver allows only for the run's own drafts.
  [AdminRole.AgentsManage]: [
    [[read, create, update], [Subject.Agent]],
    [[read, create, remove], [Subject.AgentRevision]],
  ],
  [AdminRole.RunsRead]: [[[read], [Subject.Run]]],
};

/**
 * Whether a role a run carries is one of this package's. A run's caller carries every package's roles.
 *
 * @param role - The role.
 * @returns true for this package's.
 */
function isOwnRole(role: string): role is AdminRole {
  return (ADMIN_ROLES as readonly string[]).includes(role);
}

/**
 * Builds what a caller may do to this package's subjects.
 *
 * @param caller - The caller, or null for nobody.
 * @returns A person may do everything; a run what its roles grant; a workspace key and nobody nothing.
 */
export function abilityFor(caller: Caller | null): AgentRouterAbility {
  if (caller?.kind === CALLER_RUN) {
    return abilityForRoles(caller.roles);
  }
  const { can, build } = createGraphQLAbility<Subjects>();
  if (caller?.kind === CALLER_USER) {
    can([...EVERY_ACTION], Object.values(Subject));
  }
  return build();
}

/**
 * Builds what an agent run may do with a set of roles.
 *
 * @param roles - The roles its workspace's entry for the admin server grants, every package's. Only this package's
 * are read.
 * @returns What they add up to. No roles reach nothing.
 */
export function abilityForRoles(roles: readonly string[]): AgentRouterAbility {
  const { can, build } = createGraphQLAbility<Subjects>();
  for (const role of roles.filter(isOwnRole)) {
    for (const [actions, subjects] of ROLE_GRANTS[role]) {
      can([...actions], [...subjects]);
    }
  }
  return build();
}

/** The action and subject a root field needs. */
export interface FieldGrant {
  action: Action;
  subject: Subject;
}

/**
 * Builds the four read fields drizzle-graphql generates for a table.
 *
 * @param single - The single-row field.
 * @param plural - The list field.
 * @param subject - What reading them needs.
 * @returns The fields, keyed by name.
 */
function tableReads(single: string, plural: string, subject: Subject): Record<string, FieldGrant> {
  const grant = { action: read, subject };
  return { [single]: grant, [plural]: grant, [`${plural}Aggregate`]: grant, [`${plural}GroupBy`]: grant };
}

/**
 * This package's root fields an admin-server role can reach, and what each needs. A root field missing here is for
 * people only. The host's admin server unions this with the other packages' to list a run the fields it may call.
 */
export const FIELD_GRANTS = {
  Query: {
    ...tableReads('agent', 'agents', Subject.Agent),
    ...tableReads('agentRevision', 'agentRevisions', Subject.AgentRevision),
    checkAgent: { action: read, subject: Subject.Agent },
    ...tableReads('run', 'runs', Subject.Run),
  },
  Mutation: {
    createAgent: { action: create, subject: Subject.Agent },
    saveAgent: { action: create, subject: Subject.AgentRevision },
    // The resolver lets a run discard only the drafts its own agent saved for its workspace.
    discardRevision: { action: remove, subject: Subject.AgentRevision },
  },
} as const satisfies Record<'Query' | 'Mutation', Record<string, FieldGrant>>;

/**
 * Whether a caller's ability reaches one of this package's root fields.
 *
 * @param ability - The caller's ability.
 * @param operation - `Query` or `Mutation`.
 * @param field - The field's name.
 * @returns false for a field no role reaches, and for one that is not this package's.
 */
export function canReachField(
  ability: AgentRouterAbility,
  operation: keyof typeof FIELD_GRANTS,
  field: string,
): boolean {
  const grants: Readonly<Record<string, FieldGrant>> = FIELD_GRANTS[operation];
  const grant = grants[field];
  return grant !== undefined && ability.can(grant.action, grant.subject);
}
