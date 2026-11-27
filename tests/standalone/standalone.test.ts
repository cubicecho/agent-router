import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createStandaloneApp, type StandaloneApp } from '../../server/standalone/app.ts';
import { type RunningWorker, startWorker } from '../../worker/worker.ts';
import { type Reply, sse } from '../fake-host.ts';
import { closeTestDb, createTestDb, portOf, type TestDb } from '../helpers.ts';

// agent-router on its own, over HTTP, as `npm start` serves it: a person sets an agent, a workspace, its key and a
// worker up through /graphql; an app runs the agent on /v1 and reads the run on /runs; then the same agent runs on a
// remote worker, the worker program in process, calling a tool on one of its own local servers.

/** The admin token the app is started with. */
const ADMIN_TOKEN = 'test-admin-token';
/** The fake provider's key, which only the provider may see. */
const PROVIDER_KEY = 'sk-provider';
/** The stdio fixture, as the worker's own local server. */
const FIXTURE = fileURLToPath(new URL('../tools/fixtures/stdio-server.ts', import.meta.url));
/** The fixture's echo tool, as the model calls it on the worker. */
const ECHO = 'fixture__echo';
/** Starting the worker spawns the stdio fixture, which takes seconds from a checkout on a network share. */
const WORKER_TEST_MS = 120_000;
/** Setting up builds a database, its migrations and the schema, which a loaded machine takes a while over. */
const SETUP_MS = 180_000;
/** Fast worker settings, so no test waits on a real heartbeat or retry. */
const FAST = { eventFlushMs: 10, reconnectMinMs: 20, reconnectMaxMs: 50, sendRetryMs: 10, stopDeadlineMs: 2_000 };

/** What the fake provider was sent. */
interface ProviderCall {
  path: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
}

/** A tool message in a chat request, as the model would read its result. */
interface ChatMessage {
  role: string;
  content?: unknown;
}

let db: TestDb | undefined;
let standalone: StandaloneApp | undefined;
let app: Server | undefined;
let provider: Server;
let base: string;
const received: ProviderCall[] = [];
/** Empty until the setup makes it. */
let workRoot = '';
let worker: RunningWorker | undefined;

/**
 * Reads a request's whole body.
 *
 * @param request - The request.
 * @returns Its text.
 */
async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Decides the fake model's answer: echo through the worker's tool when it is offered and not yet called, then say
 * what came back; otherwise, hello.
 *
 * @param body - The chat request.
 * @returns The answer.
 */
function script(body: Record<string, unknown>): Reply {
  const messages = (body.messages ?? []) as ChatMessage[];
  const toolResult = messages.find((message) => message.role === 'tool');
  if (toolResult !== undefined) {
    return { content: `the tool said ${JSON.stringify(toolResult.content)}` };
  }
  const tools = (body.tools ?? []) as { function?: { name?: string } }[];
  if (tools.some((tool) => tool.function?.name === ECHO)) {
    return { call: { name: ECHO, args: { text: 'from the worker' } } };
  }
  return { content: 'hello' };
}

/**
 * Runs a GraphQL operation as the admin, and fails on any error.
 *
 * @param query - The operation.
 * @param [variables] - Its variables.
 * @returns Its data.
 */
// biome-ignore lint/suspicious/noExplicitAny: each test reads the fields its own operation asked for
async function asAdmin(query: string, variables: Record<string, unknown> = {}): Promise<any> {
  const response = await fetch(`${base}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ query, variables }),
  });
  const result = (await response.json()) as { data?: unknown; errors?: { message: string }[] };
  if (result.errors !== undefined) {
    throw new Error(result.errors.map(({ message }) => message).join('\n'));
  }
  return result.data;
}

/**
 * Asks the agent something on /v1 with the workspace key.
 *
 * @param key - The workspace key.
 * @param [extra] - More request fields, such as `stream`.
 * @returns The response.
 */
function ask(key: string, extra: Record<string, unknown> = {}): Promise<Response> {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'helper', messages: [{ role: 'user', content: 'hi' }], ...extra }),
  });
}

/**
 * Reads one run's record with the workspace key.
 *
 * @param key - The workspace key.
 * @param runId - The run.
 * @returns The record.
 */
async function runRecord(key: string, runId: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}/runs/${runId}`, { headers: { authorization: `Bearer ${key}` } });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

beforeAll(async () => {
  provider = createServer(async (request, response) => {
    const text = request.method === 'POST' ? await bodyOf(request) : '{}';
    const body = JSON.parse(text) as Record<string, unknown>;
    const path = (request.url ?? '').replace(/^\/v1/, '');
    received.push({ path, authorization: request.headers.authorization, body });
    if (path === '/models') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'm1', context_length: 8_192 }] }));
      return;
    }
    response.setHeader('content-type', 'text/event-stream');
    response.end(sse(script(body)));
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));

  db = await createTestDb();
  standalone = await createStandaloneApp({
    db,
    config: {
      providers: [{ name: 'fake', baseUrl: `http://127.0.0.1:${portOf(provider)}/v1`, apiKey: PROVIDER_KEY }],
      secureLocalNet: false,
      adminToken: ADMIN_TOKEN,
      isProduction: false,
    },
    log: () => undefined,
  });
  const listening = standalone.app.listen(0, '127.0.0.1');
  app = listening;
  await new Promise<void>((resolve) => listening.once('listening', resolve));
  base = `http://127.0.0.1:${portOf(listening)}`;
  workRoot = await mkdtemp(join(tmpdir(), 'agent-router-standalone-'));
}, SETUP_MS);

afterAll(async () => {
  await worker?.stop();
  await standalone?.router.runs.stop();
  app?.closeAllConnections();
  await new Promise((resolve) => (app === undefined ? resolve(undefined) : app.close(resolve)));
  await new Promise((resolve) => provider.close(resolve));
  if (db !== undefined) {
    await closeTestDb(db);
  }
  if (workRoot !== '') {
    await rm(workRoot, { recursive: true, force: true });
  }
}, SETUP_MS);

describe('agent-router on its own', () => {
  let workspaceId: string;
  let key: string;

  it('answers /healthz', async () => {
    const response = await fetch(`${base}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });

  it('refuses /graphql to a request with no admin token', async () => {
    for (const headers of [{}, { authorization: 'Bearer wrong-token' }] as Record<string, string>[]) {
      const response = await fetch(`${base}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ query: '{ agents { id } }' }),
      });
      const result = (await response.json()) as { errors?: { extensions?: { code?: string } }[] };
      expect(result.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    }
  });

  it('sets an agent, a workspace and its key up through /graphql', async () => {
    const { createAgent } = await asAdmin('mutation ($document: JSON!) { createAgent(document: $document) { id } }', {
      document: {
        spec: 'cubicecho.agent/2',
        id: 'helper',
        name: 'Helper',
        model: { model: 'fake/m1' },
        prompt: [{ role: 'system', name: 'identity', content: 'You help.' }],
      },
    });
    const { createWorkspace } = await asAdmin(
      'mutation { createWorkspace(values: { slug: "app", name: "App" }) { id } }',
    );
    workspaceId = createWorkspace.id;
    await asAdmin('mutation ($v: CreateWorkspaceAgentInput!) { createWorkspaceAgent(values: $v) { id } }', {
      v: { workspaceId, agentId: createAgent.id },
    });
    const { createWorkspaceKey } = await asAdmin(
      'mutation ($workspaceId: UUID!) { createWorkspaceKey(workspaceId: $workspaceId, name: "app") { secret } }',
      { workspaceId },
    );
    key = createWorkspaceKey.secret;
    expect(key.startsWith('air_')).toBe(true);
  });

  it("lists the agent on /v1/models, with its provider's context length", async () => {
    const response = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${key}` } });
    const listing = (await response.json()) as { data: { id: string; context_length?: number }[] };
    expect(listing.data).toEqual([expect.objectContaining({ id: 'helper', context_length: 8_192 })]);
  });

  it('runs the agent on /v1, sending the provider its own key and model id', async () => {
    const response = await ask(key);
    expect(response.status).toBe(200);
    const answer = (await response.json()) as { choices: { message: { content: string } }[] };
    expect(answer.choices[0]?.message.content).toBe('hello');
    const call = received.findLast((each) => each.path === '/chat/completions');
    expect(call).toMatchObject({ authorization: `Bearer ${PROVIDER_KEY}`, body: { model: 'm1' } });
    const runId = response.headers.get('x-run-id') ?? '';
    expect(await runRecord(key, runId)).toMatchObject({
      id: runId,
      agent: 'helper',
      workspace: 'app',
      worker: 'local',
      status: 'completed',
    });
  });

  it('streams the answer', async () => {
    const response = await ask(key, { stream: true });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const text = await response.text();
    const content = text
      .split('\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice('data: '.length)) as { choices: { delta?: { content?: string } }[] })
      .map((chunk) => chunk.choices[0]?.delta?.content ?? '')
      .join('');
    expect(content).toBe('hello');
    expect(text).toContain('data: [DONE]');
    const runId = response.headers.get('x-run-id') ?? '';
    await vi.waitFor(async () => expect(await runRecord(key, runId)).toMatchObject({ status: 'completed' }));
  });

  it(
    "runs the agent on a remote worker, calling a tool on the worker's own server",
    async () => {
      const { createWorker } = await asAdmin('mutation { createWorker(name: "box") { secret worker { id } } }');
      const workerId = createWorker.worker.id;
      await asAdmin(
        'mutation ($workspaceId: UUID!, $workerId: UUID) { setWorkspaceWorker(workspaceId: $workspaceId, workerId: $workerId) { id } }',
        { workspaceId, workerId },
      );
      worker = await startWorker(
        {
          url: base,
          key: createWorker.secret,
          root: workRoot,
          host: 'test-host',
          servers: { fixture: { command: process.execPath, args: [FIXTURE] } },
        },
        { settings: FAST },
      );
      await vi.waitFor(
        async () => {
          const { worker: online } = await asAdmin(
            'query ($id: UUID!) { worker(where: { id: { eq: $id } }) { id online localServers } }',
            { id: workerId },
          );
          expect(online).toMatchObject({ online: true, localServers: expect.arrayContaining(['fixture']) });
        },
        { timeout: WORKER_TEST_MS / 2 },
      );

      const response = await ask(key);
      expect(response.status).toBe(200);
      const answer = (await response.json()) as { choices: { message: { content: string } }[] };
      expect(answer.choices[0]?.message.content).toContain('from the worker');
      const runId = response.headers.get('x-run-id') ?? '';
      expect(await runRecord(key, runId)).toMatchObject({ worker: 'box', status: 'completed' });
    },
    WORKER_TEST_MS,
  );
});
