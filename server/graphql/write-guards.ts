import type { WriteHookPayload } from '@vantreeseba/drizzle-graphql';
import type { AgentContext } from '../core/context.ts';
import { errorMessage } from '../core/errors.ts';

/** One written row: column values by TS key. */
export type Row = Record<string, unknown>;

/** The arguments a generated write carries rows in. */
interface WriteArgs {
  /** Rows on create. */
  values?: Row | Row[];
  /** The changed columns on update. */
  set?: Row;
}

/**
 * Collects the rows a generated write supplies.
 *
 * @param args - The mutation's arguments.
 * @returns One row per written set.
 */
export function writtenRows(args: WriteArgs): Row[] {
  if (args.values !== undefined) {
    return Array.isArray(args.values) ? args.values : [args.values];
  }
  return args.set === undefined ? [] : [args.set];
}

/**
 * Rebuilds the snapshot once a write commits, so requests route by it. An `after` hook for every table it holds.
 *
 * @param payload - The write that just ran.
 */
export function rebuildAfterCommit({ context, onCommit }: WriteHookPayload): void {
  const { snapshot }: AgentContext = context;
  onCommit(() => snapshot.rebuild());
}

/**
 * Tells the host, through its lifecycle port, about a write that has committed. A failure is logged and swallowed:
 * the write is done, and answering it as failed would only make a person try again.
 *
 * @param what - The port's method, for the log.
 * @param call - The call to the port.
 */
export async function tellHost(what: string, call: () => Promise<void>): Promise<void> {
  try {
    await call();
  } catch (error) {
    console.error(
      `[agent-router] the host's lifecycle.${what} failed, after the write committed:`,
      errorMessage(error),
    );
  }
}
