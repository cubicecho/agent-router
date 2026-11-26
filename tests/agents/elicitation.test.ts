import { ELICIT_TOOL, ElicitAction, runAgentLoop } from '@cubicecho/agent-core';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { RunStatus, runs } from '../../server/db/tables/runs.ts';
import { lastMessage, type Reply, useRunHarness } from './run-harness.ts';

// An MCP server asks for input during a tool call, and whoever called the agent answers it.

const h = useRunHarness();

/** The fixture's tool that asks, as the model calls it. */
const ASK = 'fix_ture__ask';
/** What the person types: it must reach the server and be stored nowhere. */
const SECRET = 'hunter2-do-not-store';
const QUESTION = { role: 'user', content: 'open it' };
const ACCEPTED = JSON.stringify({ action: 'accept', content: { code: SECRET } });

/**
 * Calls the asking tool, then says what it answered.
 *
 * @param body - A request to the fake model.
 * @returns The model's reply.
 */
const askScript = (body: Record<string, unknown>): Reply => {
  const last = lastMessage(body);
  return last.role === 'tool' ? { content: `The tool said: ${last.content}` } : { call: { name: ASK, args: {} } };
};

/**
 * Everything the router stored of the runs and their events, as text.
 *
 * @returns The rows, as JSON.
 */
async function storedText(): Promise<string> {
  const { rows } = await h.db.$client.query('SELECT row_to_json(r) AS row FROM run_events r');
  return JSON.stringify([await h.db.select().from(runs), rows]);
}

describe('a server asking for input during a run', () => {
  it("declines for a client that can't answer, and the tool carries on", async () => {
    const { base } = await h.startRouter();
    h.script = askScript;
    const response = await h.complete(base, { model: 'helper', messages: [QUESTION] });
    const answer = await response.json();
    expect(answer.choices[0].finish_reason).toBe('stop');
    expect(answer.choices[0].message.content).toBe('The tool said: decline');
  });

  it('hands the question to a /v1 app, carries the same call on with its answer, and stores none of it', async () => {
    const { base } = await h.startRouter();
    h.script = askScript;
    const body = { model: 'helper', messages: [QUESTION], agent_core: { progress: true } };
    const first = await (await h.complete(base, body)).json();
    const [call] = first.choices[0].message.tool_calls;
    expect(first.choices[0].finish_reason).toBe('tool_calls');
    expect(call.function.name).toBe(ELICIT_TOOL);
    expect(JSON.parse(call.function.arguments).message).toBe('What is the code?');
    const [waiting] = await h.db.select().from(runs);
    expect(waiting?.status).toBe(RunStatus.Waiting);

    const second = await h.complete(base, {
      ...body,
      messages: [QUESTION, first.choices[0].message, { role: 'tool', tool_call_id: call.id, content: ACCEPTED }],
    });
    const answer = await second.json();
    expect(answer.choices[0].message.content).toBe(`The tool said: got ${SECRET}`);
    // One run, and the tool was called once.
    const rows = await h.db.select().from(runs);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe(RunStatus.Completed);
    const events = (await (await h.get(`${base}/runs/${rows[0]?.id}/events`)).json()).events;
    expect(events.filter((event: { kind: string; via?: unknown }) => event.kind === 'tool-call')).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'elicit', text: 'What is the code?' }));
    expect(events).toContainEqual(expect.objectContaining({ kind: 'elicit-answer', text: 'accept', fields: ['code'] }));
    expect(rows[0]?.input).not.toContainEqual(expect.objectContaining({ role: 'tool' }));
    expect(JSON.stringify(rows[0]?.resume)).not.toContain(SECRET);
  });

  it("keeps a person's answer out of the run's input and events", async () => {
    const { base } = await h.startRouter();
    // A tool's own result is recorded, so this one says only how it was answered.
    h.script = (body) => {
      const last = lastMessage(body);
      return last.role === 'tool' ? { content: 'done' } : { call: { name: ASK, args: { quiet: true } } };
    };
    const body = { model: 'helper', messages: [QUESTION], agent_core: { progress: true } };
    const first = await (await h.complete(base, body)).json();
    const [call] = first.choices[0].message.tool_calls;
    const reply = { role: 'tool', tool_call_id: call.id, content: ACCEPTED };
    await (await h.complete(base, { ...body, messages: [QUESTION, first.choices[0].message, reply] })).json();
    expect(await storedText()).not.toContain(SECRET);
  });

  it('answers through agent-core, whose onElicit the loop calls by itself', async () => {
    const { base } = await h.startRouter();
    h.script = askScript;
    const asked: string[] = [];
    const result = await runAgentLoop({
      config: {
        baseUrl: `${base}/v1`,
        apiKey: h.keySecret,
        model: 'helper',
        remoteAgent: true,
        maxToolIterations: 4,
      },
      messages: [{ role: 'user', content: 'open it' }],
      dispatch: () => Promise.reject(new Error('The agent runs its own tools.')),
      onElicit: (_server, params) => {
        asked.push(params.message);
        return { action: ElicitAction.Accept, content: { code: '42' } };
      },
    });
    expect(asked).toEqual(['What is the code?']);
    expect(result.turn.content).toContain('got 42');
  });

  it('ends a run cancelled while it waits on a question', async () => {
    const { base } = await h.startRouter();
    h.script = askScript;
    const body = { model: 'helper', messages: [QUESTION], agent_core: { progress: true } };
    await (await h.complete(base, body)).json();
    const [row] = await h.db.select().from(runs);
    const cancelled = await fetch(`${base}/runs/${row?.id}/cancel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${h.keySecret}` },
    });
    expect(cancelled.ok).toBe(true);
    const ended = await h.runReaches(row?.id ?? '', RunStatus.Cancelled);
    expect(ended.pendingCallIds).toEqual([]);
  });

  it('fails a run left on a question by a restart, which can never carry it on', async () => {
    const { base, runs: service } = await h.startRouter();
    h.script = askScript;
    await (await h.complete(base, { model: 'helper', messages: [QUESTION], agent_core: { progress: true } })).json();
    const [row] = await h.db.select().from(runs);
    expect(row?.status).toBe(RunStatus.Waiting);
    await service.stop();
    const [stopped] = await h.db
      .select()
      .from(runs)
      .where(eq(runs.id, row?.id ?? ''));
    expect(stopped?.status).toBe(RunStatus.Failed);
  });
});
