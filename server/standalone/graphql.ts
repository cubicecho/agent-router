import { maxAliasesRule } from '@escape.tech/graphql-armor-max-aliases';
import { maxDepthRule } from '@escape.tech/graphql-armor-max-depth';
import {
  type DocumentNode,
  GraphQLError,
  type GraphQLSchema,
  NoSchemaIntrospectionCustomRule,
  TypeNameMetaFieldDef,
  validate,
} from 'graphql';
import {
  type ComplexityEstimator,
  fieldExtensionsEstimator,
  getComplexity,
  simpleEstimator,
} from 'graphql-query-complexity';
import { createYoga, type Plugin } from 'graphql-yoga';
import type { AgentRouter } from '../agent-router.ts';
import { API_KEY_HEADER, ConflictingKeysError, readCaller } from '../auth/caller.ts';
import { type AgentContext, CALLER_USER, type Caller } from '../core/context.ts';
import { badInput, tooComplex } from '../core/errors.ts';
import type { DB } from '../db/client.ts';
import type { PeoplePort } from '../ports.ts';
import { STANDALONE_ADMIN } from './ports.ts';

// /graphql for the standalone host: agent-router's schema as it is, behind the bounds a host puts on any operation,
// since the schema answers whatever shape it is asked for.

/** The bounds every operation is held to. */
export const OPERATION_LIMITS = Object.freeze({
  /** Levels of fields, fragments flattened. */
  maxDepth: 10,
  /** Aliases in one operation. */
  maxAliases: 30,
  /** What one operation could return, priced by drizzle-graphql's list limits. */
  maxCost: 50_000,
  /** What a field with no price of its own costs. */
  defaultFieldCost: 1,
});

/**
 * Prices `__typename` at nothing: it is answered from the row in hand, and clients add one to every selection.
 *
 * @param options - The field being priced.
 * @returns 0 for `__typename`; nothing otherwise, so the next estimator prices it.
 */
const typenameEstimator: ComplexityEstimator = ({ field }) =>
  field.name === TypeNameMetaFieldDef.name ? 0 : undefined;

/**
 * Throws `QUERY_TOO_COMPLEX` for an operation that is too deep, too aliased or could cost too much.
 *
 * @param schema - The schema it runs against.
 * @param document - The validated document.
 * @param [operationName] - Which operation.
 * @param [variables] - Its variables.
 */
function assertWithinLimits(
  schema: GraphQLSchema,
  document: DocumentNode,
  operationName?: string,
  variables: Record<string, unknown> = {},
): void {
  const refuse = (message: string) => () => {
    throw tooComplex(message);
  };
  validate(schema, document, [
    maxDepthRule({
      n: OPERATION_LIMITS.maxDepth,
      flattenFragments: true,
      propagateOnRejection: false,
      onReject: [refuse(`A query may nest at most ${OPERATION_LIMITS.maxDepth} levels deep.`)],
    }),
    maxAliasesRule({
      n: OPERATION_LIMITS.maxAliases,
      propagateOnRejection: false,
      onReject: [refuse(`A query may use at most ${OPERATION_LIMITS.maxAliases} aliases.`)],
    }),
  ]);
  let cost = 0;
  try {
    cost = getComplexity({
      schema,
      query: document,
      operationName,
      variables,
      estimators: [
        typenameEstimator,
        fieldExtensionsEstimator(),
        simpleEstimator({ defaultComplexity: OPERATION_LIMITS.defaultFieldCost }),
      ],
    });
  } catch (error) {
    // Variables that don't fit their types: execution reports that, and runs nothing.
    if (error instanceof GraphQLError === false) {
      throw error;
    }
  }
  if (cost > OPERATION_LIMITS.maxCost) {
    throw tooComplex(
      `This query costs ${cost}; the most one may cost is ${OPERATION_LIMITS.maxCost}. Ask for fewer rows.`,
    );
  }
}

/** Holds every operation to {@link OPERATION_LIMITS}, before anything executes. */
const useOperationLimits = (): Plugin => ({
  onExecute: ({ args }) => {
    assertWithinLimits(args.schema, args.document, args.operationName ?? undefined, args.variableValues ?? undefined);
  },
});

/** Refuses introspection, so a production host doesn't hand out its schema. */
const useNoIntrospection = (): Plugin => ({
  onValidate: ({ addValidationRule }) => {
    addValidationRule(NoSchemaIntrospectionCustomRule);
  },
});

/** What the handler reads a caller with. */
export interface GraphQLHandlerDeps {
  db: DB;
  router: AgentRouter;
  people: PeoplePort;
  /** A request that presents no credential is the admin. */
  secureLocalNet: boolean;
  isProduction: boolean;
  now?: () => Date;
}

/**
 * Whether a request presents no credential at all: no `Authorization`, no `x-api-key`.
 *
 * @param headers - Its headers.
 * @returns Whether it presents nothing.
 */
function presentsNothing(headers: Headers): boolean {
  return (headers.get('authorization') ?? '').trim() === '' && (headers.get(API_KEY_HEADER) ?? '').trim() === '';
}

/**
 * Builds the Yoga handler for /graphql over agent-router's schema.
 *
 * @param deps - The database, agent-router, the people port and the trusted-network switch.
 * @returns The Yoga instance, callable as Express middleware.
 */
export function createStandaloneGraphQL({
  db,
  router,
  people,
  secureLocalNet,
  isProduction,
  now = () => new Date(),
}: GraphQLHandlerDeps) {
  return createYoga<Record<string, unknown>, AgentContext>({
    schema: router.schema,
    graphqlEndpoint: '/graphql',
    graphiql: isProduction === false,
    plugins: [useOperationLimits(), ...(isProduction ? [useNoIntrospection()] : [])],
    context: async ({ request }): Promise<AgentContext> => {
      let caller: Caller | null;
      try {
        caller = await readCaller({ people, snapshot: router.snapshot.current(), now: now() }, request.headers);
      } catch (error) {
        throw error instanceof ConflictingKeysError ? badInput(error.message) : error;
      }
      // On a trusted network, whoever presents nothing is the admin. A key is still read as the key.
      if (caller === null && secureLocalNet && presentsNothing(request.headers)) {
        caller = { kind: CALLER_USER, ...STANDALONE_ADMIN };
      }
      return { db, snapshot: router.snapshot, runs: router.runs, caller, request };
    },
  });
}
