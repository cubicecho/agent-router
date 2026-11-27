import { type Action, Actions, accept, deny, type PermissionsMap, type Rule, rule } from '@vantreeseba/graphql-casl';
import { type AgentContext, CALLER_RUN, CALLER_USER } from '../core/context.ts';
import { forbidden, unauthenticated } from '../core/errors.ts';
import { type AgentRouterAbility, abilityFor, FIELD_GRANTS, type FieldGrant, Subject } from './abilities.ts';

// Who may call what in this package's schema. A person may call anything here: nothing in it is an admin's alone. An
// agent run reaches only the fields in FIELD_GRANTS that its workspace's roles allow (abilities.ts). A workspace key
// is refused everywhere. Mutations are a whitelist, so a generated write a new table adds arrives shut, and a root
// field missing from FIELD_GRANTS is for people only. The rules travel with the schema, so a host that merges it
// keeps them.

/** What a workspace key is told. */
const PEOPLE_ONLY = 'The admin API is for people signed in to the router. A workspace key cannot use it.';
/** What an agent run reaching past its roles is told. */
const PAST_ROLES = "Its workspace's roles for the admin server don't allow this.";
/** What an agent run reaching for something only people do is told. */
const RUNS_NEVER = 'Only a person can do this. An agent run cannot, whatever its roles.';

/** Each request's ability, built once. */
const abilities = new WeakMap<AgentContext, AgentRouterAbility>();

/**
 * Reads the ability of a request's caller, building it on first use.
 *
 * @param ctx - The request.
 * @returns What its caller may do.
 */
function abilityOf(ctx: AgentContext): AgentRouterAbility {
  const known = abilities.get(ctx);
  if (known !== undefined) {
    return known;
  }
  const built = abilityFor(ctx.caller);
  abilities.set(ctx, built);
  return built;
}

/**
 * Refuses everyone but a signed-in person.
 *
 * @param _parent - Unused.
 * @param _args - Unused.
 * @param ctx - The request.
 * @returns true for a person, otherwise the error to refuse with.
 */
function checkUser(_parent: unknown, _args: unknown, ctx: AgentContext): true | Error {
  if (ctx.caller === null) {
    return unauthenticated('Sign in first.');
  }
  if (ctx.caller.kind === CALLER_RUN) {
    return forbidden(RUNS_NEVER);
  }
  return ctx.caller.kind === CALLER_USER ? true : forbidden(PEOPLE_ONLY);
}

/**
 * Builds the rule for something a person may do, and an agent run only when its roles allow.
 *
 * @param action - What is done.
 * @param subject - To what.
 * @returns The rule.
 */
function canDo(action: Action, subject: Subject): Rule {
  return rule(
    (_parent, _args, ctx: AgentContext) => {
      const { caller } = ctx;
      if (caller === null) {
        return unauthenticated('Sign in first.');
      }
      if (caller.kind !== CALLER_USER && caller.kind !== CALLER_RUN) {
        return forbidden(PEOPLE_ONLY);
      }
      return abilityOf(ctx).can(action, subject) ? true : forbidden(PAST_ROLES);
    },
    { name: `can ${action} ${subject}`, cache: 'contextual' },
  );
}

/**
 * Builds the rules for the root fields a role can reach.
 *
 * @param grants - The fields, with what each needs.
 * @returns A rule for each.
 */
function grantedFields(grants: Readonly<Record<string, FieldGrant>>): Record<string, Rule> {
  return Object.fromEntries(
    Object.entries(grants).map(([field, { action, subject }]) => [field, canDo(action, subject)]),
  );
}

/** Any signed-in person. */
const isUser = rule(checkUser, { name: 'isUser', cache: 'contextual' });

const { read } = Actions;

/** The schema's permission map. Applied once, in `buildAgentRouterSchema`. */
export const permissions: PermissionsMap = {
  '*': accept,
  Query: {
    '*': isUser,
    ...grantedFields(FIELD_GRANTS.Query),
  },
  // A run's live events are for people. An app reads its runs at /runs.
  Subscription: {
    '*': isUser,
  },
  Mutation: {
    '*': deny,
    ...grantedFields(FIELD_GRANTS.Mutation),
    createWorkspace: isUser,
    updateWorkspace: isUser,
    deleteWorkspace: isUser,
    // People only: no admin-server role reaches it, since it widens what the new workspace's runs reach.
    copyWorkspace: isUser,
    createWorkspaceKey: isUser,
    revokeWorkspaceKey: isUser,
    // People only: no admin-server role reaches a worker, its key, or where a workspace's runs go.
    createWorker: isUser,
    rotateWorkerKey: isUser,
    deleteWorker: isUser,
    setWorkspaceWorker: isUser,
    promoteRevision: isUser,
    setAgentAutoPromote: isUser,
    deleteAgent: isUser,
    createWorkspaceAgent: isUser,
    deleteWorkspaceAgent: isUser,
    // People only: no admin-server role reaches it, so a run never turns a server on for itself.
    setWorkspaceAgentServerEnabled: isUser,
    // People only: no admin-server role reaches it, so a run never turns a tool on for itself.
    setWorkspaceAgentToolEnabled: isUser,
    // People only, never a run on the admin server: no role grants stopping another run.
    cancelRun: isUser,
  },
  // A rule on a type guards it wherever it is reached, a relation included, so a run's read of an agent can't walk
  // into the workspaces that run it.
  Agent: canDo(read, Subject.Agent),
  AgentRevision: canDo(read, Subject.AgentRevision),
  Run: canDo(read, Subject.Run),
  // Read across every workspace, so people only: a run on the admin server reaches its own workspace's runs.
  RunSession: isUser,
  RunSessionPage: isUser,
  Conversation: isUser,
  Worker: isUser,
  Workspace: isUser,
  WorkspaceAgent: isUser,
  WorkspaceAgentDisabledServer: isUser,
  WorkspaceAgentDisabledTool: isUser,
  WorkspaceKey: isUser,
};
