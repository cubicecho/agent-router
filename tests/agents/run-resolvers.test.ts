import type { ExecutionResult } from 'graphql';
import { describe, expect, it } from 'vitest';
import { AdminRole } from '../../server/core/admin-roles.ts';
import { CALLER_RUN, CALLER_WORKSPACE } from '../../server/core/context.ts';
import { HttpStatus } from '../../server/core/wire.ts';
import { RunStatus, runs } from '../../server/db/tables/runs.ts';
import { createClient, personCaller, type TestClient } from '../graphql-client.ts';
import { createWorkspaceWithKey, workspaceCaller } from '../helpers.ts';
import { ECHO, lastMessage, QUESTION, type Reply, until, useRunHarness } from './run-harness.ts';

// The runs fields of this package's schema, over runs the harness started on /v1: Run.events, the runEvents
// subscription, runSessions and cancelRun.

const h = useRunHarness();

const CANCEL_RUN = 'mutation ($id: UUID!, $reason: String) { cancelRun(id: $id, reason: $reason) { id status error } }';
const SESSIONS = `query ($workspaceId: UUID, $limit: Int) {
  runSessions(workspaceId: $workspaceId, limit: $limit) { count sessions { key workspaceName agentNames runCount } }
}`;
/** Long enough that a run still in the tool call when the test ends was never cancelled. */
const LONG_SLEEP_MS = 60_000;
/** Calls the fixture's `sleep` for a long time. */
const SLOW_SCRIPT = (): Reply => ({ call: { name: 'fix_ture__sleep', args: { ms: LONG_SLEEP_MS } } });
/** The app's tool. */
const ASK_USER = { type: 'function', function: { name: 'ask_user', parameters: { type: 'object' } } };
/** Asks the user, then answers with what the app said. */
const ASK_SCRIPT = (body: Record<string, unknown>): Reply =>
  lastMessage(body).role === 'tool' ? { content: 'thanks' } : { call: { name: 'ask_user', args: {} } };

/**
 * Makes a person's client over the router a test started, so it reaches the runs going there.
 *
 * @param runService - The started router's runs.
 * @param [caller] - Who calls: a person by default.
 * @returns The client.
 */
function clientOver(
  runService: Awaited<ReturnType<typeof h.startRouter>>['runs'],
  caller: Parameters<typeof createClient>[1] = personCaller(),
): TestClient {
  return createClient(h.db, caller, { host: h.host, snapshot: h.snapshot, runs: runService });
}

/**
 * Runs the helper to its answer.
 *
 * @param base - The router.
 * @param [headers] - Extra headers.
 * @returns The run's id.
 */
async function runOnce(base: string, headers: Record<string, string> = {}): Promise<string> {
  const response = await h.complete(base, { model: 'helper', messages: [QUESTION] }, headers);
  expect(response.status).toBe(HttpStatus.Ok);
  await response.json();
  return response.headers.get('x-run-id') ?? '';
}

/**
 * Reads every event a subscription yields, until it ends.
 *
 * @param followed - What `follow` answered.
 * @returns The payloads, or the refusal.
 */
async function drain(followed: AsyncGenerator<ExecutionResult> | ExecutionResult): Promise<ExecutionResult[]> {
  if (Symbol.asyncIterator in followed === false) {
    return [followed];
  }
  const results: ExecutionResult[] = [];
  for await (const result of followed as AsyncGenerator<ExecutionResult>) {
    results.push(result);
  }
  return results;
}

describe('Run.events and runEvents', () => {
  it("serve a run's stored events, folded if asked, and replay them to a person who subscribes after it ended", async () => {
    const { base, runs: runService } = await h.startRouter();
    const runId = await runOnce(base);
    const asUser = clientOver(runService);
    const { run } = await asUser.expectOk(
      `query ($id: UUID!) {
        run(where: { id: { eq: $id } }) {
          id
          all: events { seq kind name text ok }
          page: events(afterSeq: 2, limit: 2) { seq }
          folded: events(folded: true) { kind text }
        }
      }`,
      { id: runId },
    );
    expect(run.all[0]).toMatchObject({ seq: 1 });
    expect(
      run.all.some((event: { kind: string; name: string }) => event.kind === 'tool-call' && event.name === ECHO),
    ).toBe(true);
    expect(run.all.at(-1)).toMatchObject({ kind: 'done', ok: true });
    expect(run.page).toEqual([{ seq: 3 }, { seq: 4 }]);
    const outputs = run.folded.filter((event: { kind: string }) => event.kind === 'output');
    expect(outputs.map((event: { text: string }) => event.text)).toEqual(['The tool said: hello there']);
    const refused = await asUser.expectError(
      'query ($id: UUID!) { run(where: { id: { eq: $id } }) { id events(limit: 0) { seq } } }',
      { id: runId },
    );
    expect(refused.code).toBe('BAD_USER_INPUT');

    const SUBSCRIBE = 'subscription ($id: UUID!) { runEvents(runId: $id, afterSeq: 1) { runId seq kind } }';
    const followed = await drain(await asUser.follow(SUBSCRIBE, { id: runId }));
    const seqs = followed.map((result) => (result.data?.runEvents as { seq: number } | undefined)?.seq);
    expect(seqs).toEqual(run.all.slice(1).map((event: { seq: number }) => event.seq));

    const asKey = clientOver(runService, workspaceCaller(h.workspaceId, h.keyId));
    const [keyRefused] = await drain(await asKey.follow(SUBSCRIBE, { id: runId }));
    expect(keyRefused?.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
  });
});

describe('runSessions', () => {
  it("groups one workspace's runs by key, pages them, and is for people only", async () => {
    h.script = () => ({ content: 'done' });
    const { base, runs: runService } = await h.startRouter();
    await runOnce(base, { 'x-session-id': 'chat-1' });
    await runOnce(base, { 'x-session-id': 'chat-1' });
    await runOnce(base, { 'x-session-id': 'chat-2' });
    await runOnce(base);
    const asUser = clientOver(runService);
    const { runSessions } = await asUser.expectOk(SESSIONS, { workspaceId: h.workspaceId });
    expect(runSessions).toEqual({
      count: 2,
      sessions: [
        { key: 'chat-2', workspaceName: 'task-server', agentNames: ['helper'], runCount: 1 },
        { key: 'chat-1', workspaceName: 'task-server', agentNames: ['helper'], runCount: 2 },
      ],
    });
    expect((await asUser.expectError(SESSIONS, { limit: 0 })).code).toBe('BAD_USER_INPUT');
    const app = await createWorkspaceWithKey(h.db, 'min-agent');
    const asApp = clientOver(runService, workspaceCaller(app.workspaceId, app.keyId));
    expect((await asApp.expectError(SESSIONS)).code).toBe('FORBIDDEN');
  });
});

describe('cancelRun', () => {
  it('lets a person cancel any run, saying a person did when they give no reason', async () => {
    h.script = SLOW_SCRIPT;
    const { base, runs: runService } = await h.startRouter();
    const asUser = clientOver(runService);
    const response = h.complete(base, { model: 'helper', messages: [QUESTION] });
    await until(() => h.received.length > 0, 'the model call');
    const [running] = await h.db.select().from(runs);
    const { cancelRun } = await asUser.expectOk(CANCEL_RUN, { id: running?.id });
    expect(cancelRun).toEqual({ id: running?.id, status: RunStatus.Cancelled, error: 'Cancelled by a person.' });
    expect((await response).status).toBe(HttpStatus.Conflict);

    h.script = ASK_SCRIPT;
    const waiting = await h.complete(base, { model: 'helper', messages: [QUESTION], tools: [ASK_USER] });
    const runId = waiting.headers.get('x-run-id') ?? '';
    await waiting.json();
    const { cancelRun: waited } = await asUser.expectOk(CANCEL_RUN, { id: runId, reason: 'Not needed.' });
    expect(waited).toMatchObject({ status: RunStatus.Cancelled, error: 'Not needed.' });
    const missing = await asUser.expectError(CANCEL_RUN, { id: '00000000-0000-4000-8000-000000000000' });
    expect(missing.code).toBe('NOT_FOUND');
  });

  it('is shut to a workspace key and to an agent run, whatever its roles', async () => {
    h.script = ASK_SCRIPT;
    const { base, runs: runService } = await h.startRouter();
    const waiting = await h.complete(base, { model: 'helper', messages: [QUESTION], tools: [ASK_USER] });
    const runId = waiting.headers.get('x-run-id') ?? '';
    await waiting.json();
    const asKey = clientOver(runService, { kind: CALLER_WORKSPACE, workspaceId: h.workspaceId, keyId: 'k' });
    expect((await asKey.expectError(CANCEL_RUN, { id: runId })).code).toBe('FORBIDDEN');
    const asRun = clientOver(runService, {
      kind: CALLER_RUN,
      runId,
      workspaceId: h.workspaceId,
      agentId: h.agentId,
      roles: Object.values(AdminRole),
      depth: 1,
    });
    expect((await asRun.expectError(CANCEL_RUN, { id: runId })).code).toBe('FORBIDDEN');
    expect((await h.runReaches(runId, RunStatus.Waiting)).status).toBe(RunStatus.Waiting);
  });
});
