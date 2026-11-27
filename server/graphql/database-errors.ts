import { defaultErrorMapper } from '@vantreeseba/drizzle-graphql';
import { badInput } from '../core/errors.ts';
import { violatedUniqueIndex } from '../db/errors.ts';

/** What a caller is told when a write breaks a unique index, by the index's name. */
const UNIQUE_MESSAGES: Readonly<Record<string, string>> = {
  uq_workspaces_slug: 'A workspace with that slug already exists.',
  uq_agents_name: 'An agent with that name already exists.',
  uq_workspace_agents_workspace_id_agent_id: 'This workspace can already run that agent.',
};

/**
 * Turns a database error a person can fix into BAD_USER_INPUT, and leaves the rest to drizzle-graphql's masking.
 *
 * @param error - What a generated resolver threw.
 * @returns The error the caller sees.
 */
export function mapDatabaseError(error: unknown): unknown {
  const index = violatedUniqueIndex(error);
  const message = index === null ? undefined : UNIQUE_MESSAGES[index];
  return message === undefined ? defaultErrorMapper(error) : badInput(message);
}
