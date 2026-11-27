import { buildSchema } from '@vantreeseba/drizzle-graphql';
import { applyPermissions } from '@vantreeseba/graphql-casl';
import { type AnyColumn, eq } from 'drizzle-orm';
import { GraphQLObjectType, GraphQLSchema } from 'graphql';
import { agentWriteHooks } from '../agents/hooks.ts';
import { applyAgentsExtension } from '../agents/resolvers.ts';
import { applyRunsExtension } from '../agents/run-resolvers.ts';
import { type AgentContext, CALLER_RUN } from '../core/context.ts';
import { OPERATION_LIMIT_DEFAULTS } from '../core/defaults.ts';
import { forbidden } from '../core/errors.ts';
import type { DB } from '../db/client.ts';
import type { AgentRouterPorts } from '../ports.ts';
import { applyWorkersExtension } from '../workers/resolvers.ts';
import { workspaceWriteHooks } from '../workspaces/hooks.ts';
import { applyWorkspacesExtension } from '../workspaces/resolvers.ts';
import { mapDatabaseError } from './database-errors.ts';
import { permissions } from './permissions.ts';

/** Tables served only through hand-written fields: a run's events are `Run.events`, in the subscription's shape. */
const HAND_SERVED_TABLES = ['runEvents'];

/**
 * Tables whose writes belong to hand-written mutations or to the runs: keys, workers, revisions, runs,
 * conversations, and the servers and tools turned off for an agent in a workspace.
 */
const WRITES_RESERVED = new Set<string>([
  'workspaceKeys',
  'workers',
  'agentRevisions',
  'runs',
  'conversations',
  'workspaceAgentDisabledServers',
  'workspaceAgentDisabledTools',
]);

/** Tables whose rows are created and changed only by hand-written mutations: an agent, by `createAgent` and its revisions. */
const AGENTS_BY_HAND = new Set<string>(['agents']);

/**
 * Whether a table keeps one kind of generated write.
 *
 * @param reserved - The tables whose writes of that kind are hand-written, beside {@link WRITES_RESERVED}.
 * @returns The check.
 */
const allowedUnless =
  (reserved: ReadonlySet<string>) =>
  (table: string): boolean =>
    WRITES_RESERVED.has(table) === false && reserved.has(table) === false;

/** No table beyond {@link WRITES_RESERVED}. */
const NONE = new Set<string>();

/**
 * Adds an empty Mutation root when every generated write is off, so `extend type Mutation` has a target.
 *
 * @param schema - Generated schema.
 * @returns The schema, with a Mutation root.
 */
function withMutationRoot(schema: GraphQLSchema): GraphQLSchema {
  if (schema.getMutationType() !== undefined && schema.getMutationType() !== null) {
    return schema;
  }
  return new GraphQLSchema({ ...schema.toConfig(), mutation: new GraphQLObjectType({ name: 'Mutation', fields: {} }) });
}

/** What the schema is built over. */
export interface AgentRouterSchemaDeps {
  /** The database the resolvers query: the host's Postgres, with this package's migrations applied. */
  db: DB;
  /** The host's view, for the servers a workspace has, and its lifecycle port, told of deletes and copies. */
  ports: Pick<AgentRouterPorts, 'readHostView' | 'lifecycle'>;
}

/**
 * Builds this package's complete GraphQL schema: the generated CRUD over its own tables, its hand-written fields, then
 * its permissions. A host serves it as it is, or merges it with the other packages' finished schemas. Its resolvers
 * read an {@link AgentContext}, which the host's own context is.
 *
 * @param deps - The database and the ports the resolvers use.
 * @returns The permission-wrapped schema.
 *
 * @remarks
 * Nothing in it crosses into the host: a workspace's servers, a revision's or key's creator (`createdBy` is a plain
 * id), and filters through either are the host's to add when it merges the schemas.
 */
export function buildAgentRouterSchema({ db, ports }: AgentRouterSchemaDeps): GraphQLSchema {
  const { schema: generated } = buildSchema(db, {
    prefixes: { insert: 'create', update: 'update', delete: 'delete' },
    // Table keys are plural (`workspaces`). Types and single-row fields are singular (Workspace, workspace).
    typeNameMapper: 'singularize',
    exclude: {
      tables: HAND_SERVED_TABLES,
      columns: {
        workspaceKeys: ['hash'],
        workers: ['keyHash'],
        // A fingerprint of an app's request: of no use to a person, and a way to test a guess at what it said.
        // A waiting run's transcript and the app's tools: what it carries on with, not what it is.
        runs: ['requestHash', 'resume'],
      },
    },
    features: {
      insert: allowedUnless(AGENTS_BY_HAND),
      update: allowedUnless(AGENTS_BY_HAND),
      updateMany: allowedUnless(AGENTS_BY_HAND),
      delete: allowedUnless(NONE),
      // The hooks read the root field's args, not a nested child's. Stated so nobody turns it on.
      nestedWrites: false,
    },
    limits: {
      defaultLimit: OPERATION_LIMIT_DEFAULTS.defaultPageSize,
      maxLimit: OPERATION_LIMIT_DEFAULTS.maxPageSize,
    },
    complexity: true,
    // An agent run reads only the runs its own workspace started, a relation's included. People read every run.
    scope: {
      runs: (ctx: AgentContext, table: { workspaceId: AnyColumn }) =>
        ctx.caller?.kind === CALLER_RUN ? eq(table.workspaceId, ctx.caller.workspaceId) : undefined,
    },
    onWrite: { ...workspaceWriteHooks(ports.lifecycle), ...agentWriteHooks(ports.lifecycle) },
    onError: mapDatabaseError,
  });

  const extended = applyRunsExtension(
    applyAgentsExtension(
      applyWorkspacesExtension(applyWorkersExtension(withMutationRoot(generated), ports.lifecycle), ports),
    ),
  );
  return applyPermissions(extended, permissions, {
    // A refusal names the field, so a client can tell which call to stop making.
    fallbackError: (_original, _parent, _args, _context, info) =>
      forbidden(`Not allowed to call ${info.parentType.name}.${info.fieldName}.`),
  });
}
