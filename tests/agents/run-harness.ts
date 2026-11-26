import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '@cubicecho/agent-core';
import { eq } from 'drizzle-orm';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, expect } from 'vitest';
import { createAgentRouter, WORKERS_PATH } from '../../server/agent-router.ts';
import type { RunService } from '../../server/agents/run.ts';
import type { RunSettings } from '../../server/core/defaults.ts';
import { createSnapshotHost, type SnapshotHost } from '../../server/db/snapshot.ts';
import { type RunStatus, runs } from '../../server/db/tables/runs.ts';
import { workspaceAgentDisabledServers } from '../../server/db/tables/workspace-agent-disabled-servers.ts';
import { workspaceAgents } from '../../server/db/tables/workspace-agents.ts';
import type { RemoteWorkers } from '../../server/workers/remote.ts';
import { FakeHost, PROVIDER_CONTEXT_LENGTH, type Reply, type ScriptCall } from '../fake-host.ts';
import {
  closeTestDb,
  createAgent,
  createTestDb,
  createWorkspaceWithKey,
  portOf,
  resetTestDb,
  type TestDb,
} from '../helpers.ts';

// agent-router end to end for the agents tests: its /v1, /mcp, /runs and worker doors on a real socket, over the
// test host's scripted model and the stdio fixture as the agent's MCP server.

export { PROVIDER_CONTEXT_LENGTH, type Reply, type ScriptCall };

/** The stdio fixture, run with this process's node. */
export const FIXTURE = fileURLToPath(new URL('../tools/fixtures/stdio-server.ts', import.meta.url));
/** A server name with a `.`, which no OpenAI function name may hold. */
export const SERVER = 'fix.ture';
/** What the fixture's `echo` is called as, once the router has named it for the model. */
export const ECHO = 'fix_ture__echo';
export const AGENT_PROMPT = 'You answer with what the tool said.';
export const QUESTION = { role: 'user', content: 'hello there' };

/** A message the fake model was sent. */
export interface SentMessage {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
}

/** The `helper` agent's document, which every test starts with. */
export const HELPER_DOCUMENT = Object.freeze({
  spec: 'cubicecho.agent/2',
  id: 'helper',
  name: 'Helper',
  description: 'Answers with what its tool said.',
  model: { model: 'fake/m1', temperature: 0.2 },
  prompt: [{ role: 'system', name: 'role', content: AGENT_PROMPT }],
  tools: { servers: [SERVER], maxIterations: 4 },
});

/**
 * The newest message the fake model was sent.
 *
 * @param body - A request body.
 * @returns Its role and content.
 */
export function lastMessage(body: Record<string, unknown>): { role: string; content: string } {
  const messages = sentMessages(body);
  const last = messages.at(-1);
  return { role: String(last?.role ?? ''), content: typeof last?.content === 'string' ? last.content : '' };
}

/**
 * The messages a request to the fake model carried.
 *
 * @param body - A request body.
 * @returns Its messages.
 */
export function sentMessages(body: Record<string, unknown> | undefined): SentMessage[] {
  return Array.isArray(body?.messages) ? body.messages : [];
}

/**
 * The names of the tools a request to the fake model declared.
 *
 * @param body - A request body.
 * @returns The function names.
 */
export function sentToolNames(body: Record<string, unknown> | undefined): string[] {
  return (Array.isArray(body?.tools) ? body.tools : []).map(
    (tool: { function: { name: string } }) => tool.function.name,
  );
}

/** Calls `echo` with the question, then answers with what it said. */
export const ECHO_SCRIPT = (body: Record<string, unknown>): Reply => {
  const last = lastMessage(body);
  return last.role === 'tool'
    ? { content: `The tool said: ${last.content}` }
    : { call: { name: ECHO, args: { text: last.content } } };
};

/**
 * Reads an event stream's data lines.
 *
 * @param response - A streamed answer.
 * @returns Each `data:` payload, parsed, with `[DONE]` as the string.
 */
export async function dataLines(response: Response): Promise<unknown[]> {
  const text = await response.text();
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length))
    .map((data) => (data === '[DONE]' ? data : JSON.parse(data)));
}

/**
 * Checks that events are in order with no repeat: their `seq`s only increase. Stored events have gaps where a stretch
 * of streamed text was folded into one, under its last event's `seq`.
 *
 * @param events - The events.
 */
export function expectInOrder(events: readonly { seq: number }[]): void {
  const seqs = events.map((event) => event.seq);
  const isIncreasing = seqs.every((seq, index) => index === 0 || seq > (seqs[index - 1] ?? seq));
  expect(isIncreasing).toBe(true);
}

/** How many times `until` asks. */
const UNTIL_ATTEMPTS = 250;
/** How long `until` waits between asks. */
const UNTIL_INTERVAL_MS = 20;

/**
 * Waits until a condition holds.
 *
 * @param check - Asked every 20 ms.
 * @param [what] - What is waited for, for the failure.
 */
export async function until(check: () => boolean | Promise<boolean>, what = 'the condition'): Promise<void> {
  for (let attempt = 0; attempt < UNTIL_ATTEMPTS; attempt += 1) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, UNTIL_INTERVAL_MS));
  }
  throw new Error(`Waited too long for ${what}.`);
}

/** What a test file gets from the harness. The hooks `useRunHarness` registers fill in its fields. */
export class RunHarness {
  db!: TestDb;
  host!: FakeHost;
  snapshot!: SnapshotHost;
  workspaceId!: string;
  keyId!: string;
  keySecret!: string;
  agentId!: string;
  revisionId!: string;
  /** The `helper` agent's place in the workspace. */
  helperEntryId!: string;
  /** The routers started in this test, which the harness stops after it. */
  started: { server: Server; runs: RunService }[] = [];

  /** The bodies the fake model was sent, chat completions only. */
  get received(): Record<string, unknown>[] {
    return this.host.received.map((call) => call.body);
  }

  /** The headers of those requests, in the same order. */
  get receivedHeaders(): Record<string, string>[] {
    return this.host.received.map((call) => call.headers);
  }

  /** Decides each answer of the fake model. */
  get script(): (body: Record<string, unknown>) => Reply {
    return this.host.script;
  }

  set script(script: (body: Record<string, unknown>) => Reply) {
    this.host.script = script;
  }

  /**
   * Adds an agent and rebuilds the snapshot.
   *
   * @param document - Its document.
   * @returns Its id and live revision.
   */
  async createAgent(document: Record<string, unknown>): Promise<{ id: string; liveRevisionId: string }> {
    const created = await createAgent(this.db, document);
    await this.snapshot.rebuild();
    return created;
  }

  /**
   * Lets a workspace's apps run an agent that reaches exactly the servers named, as a person does on the workspace
   * page: each named server is put in the workspace if it isn't there, and the workspace's others are turned off for
   * the agent.
   *
   * @param workspaceId - The workspace.
   * @param agentId - The agent.
   * @param [serverNames] - The servers it reaches there: the harness's own, unless told otherwise.
   * @returns The agent's place in the workspace.
   */
  async offer(workspaceId: string, agentId: string, serverNames: readonly string[] = [SERVER]): Promise<string> {
    const [entry] = await this.db.insert(workspaceAgents).values({ workspaceId, agentId }).returning();
    if (entry === undefined) {
      throw new Error('The workspace agent was not inserted.');
    }
    for (const name of serverNames) {
      this.addToWorkspace(workspaceId, name);
    }
    const inWorkspace = this.host.workspaceServers.get(workspaceId) ?? [];
    for (const server of this.host.servers.values()) {
      const isOther = inWorkspace.includes(server.id) && serverNames.includes(server.name) === false;
      if (isOther) {
        await this.db.insert(workspaceAgentDisabledServers).values({ workspaceAgentId: entry.id, serverId: server.id });
      }
    }
    await this.snapshot.rebuild();
    return entry.id;
  }

  /**
   * Puts one of the host's servers in a workspace, unless it is there already. Rebuild the snapshot after.
   *
   * @param workspaceId - The workspace.
   * @param name - The server.
   */
  addToWorkspace(workspaceId: string, name: string): void {
    const server = this.host.servers.get(name);
    if (server === undefined) {
      throw new Error(`The host has no server ${name}.`);
    }
    this.host.addToWorkspace(workspaceId, server.id);
  }

  /**
   * Starts agent-router's doors on a real socket, as a host mounts them.
   *
   * @param [overrides] - Run settings that differ.
   * @param [workers] - The remote workers, for a test that dials one in.
   * @returns Its address and run service.
   */
  async startRouter(
    overrides: Partial<RunSettings> = {},
    workers?: RemoteWorkers,
  ): Promise<{ base: string; runs: RunService }> {
    const router = await createAgentRouter({
      db: this.db,
      ports: this.host.ports(),
      snapshot: this.snapshot,
      runtime: createRuntime(),
      overrides,
      ...(workers === undefined ? {} : { workers }),
    });
    const app = express();
    app.disable('x-powered-by');
    app.use('/v1', router.routes.v1);
    app.use('/mcp', router.routes.mcp);
    app.use('/runs', router.routes.runs);
    app.use(WORKERS_PATH, router.routes.workers);
    const server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    this.started.push({ server, runs: router.runs });
    return { base: `http://127.0.0.1:${portOf(server)}`, runs: router.runs };
  }

  /**
   * Asks for a chat completion with the workspace's key.
   *
   * @param base - The router.
   * @param body - The request body.
   * @param [headers] - Extra headers, which may replace the key.
   * @returns The answer.
   */
  complete(base: string, body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.keySecret}`, ...headers },
      body: JSON.stringify(body),
    });
  }

  /**
   * Reads a path of the router with the workspace's key.
   *
   * @param url - The whole URL.
   * @param [headers] - Extra headers, which may replace the key.
   * @returns The answer.
   */
  get(url: string, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(url, { headers: { authorization: `Bearer ${this.keySecret}`, ...headers } });
  }

  /**
   * Waits for a run to reach a status.
   *
   * @param runId - The run.
   * @param status - The status.
   * @returns The run's row.
   */
  async runReaches(runId: string, status: RunStatus): Promise<typeof runs.$inferSelect> {
    let found: typeof runs.$inferSelect | undefined;
    await until(async () => {
      [found] = await this.db.select().from(runs).where(eq(runs.id, runId));
      return found?.status === status;
    }, `run ${runId} to reach ${status}`);
    if (found === undefined) {
      throw new Error(`Run ${runId} is gone.`);
    }
    return found;
  }
}

/**
 * Sets up agent-router for a test file: a database for the file, and for each test a test host with the fixture
 * server and the fake model, a workspace with a key, and the `helper` agent, offered to the workspace.
 *
 * @returns The harness, whose fields the hooks fill in.
 */
export function useRunHarness(): RunHarness {
  const h = new RunHarness();

  beforeAll(async () => {
    h.db = await createTestDb();
  });

  afterAll(async () => {
    await closeTestDb(h.db);
  });

  beforeEach(async () => {
    await resetTestDb(h.db);
    h.host = new FakeHost();
    h.script = ECHO_SCRIPT;
    h.host.addServer(SERVER, process.execPath, [FIXTURE]);
    h.snapshot = await createSnapshotHost(h.db, async () => h.host.view());
    ({
      workspaceId: h.workspaceId,
      keyId: h.keyId,
      secret: h.keySecret,
    } = await createWorkspaceWithKey(h.db, 'task-server'));
    const created = await h.createAgent({ ...HELPER_DOCUMENT });
    h.agentId = created.id;
    h.revisionId = created.liveRevisionId;
    h.helperEntryId = await h.offer(h.workspaceId, h.agentId);
  });

  afterEach(async () => {
    for (const { server, runs: runService } of h.started) {
      await runService.stop();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    h.started = [];
    await h.host.stop();
  });

  return h;
}
