import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { type CallToolResult, ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ROUTER_DEFAULTS, type RouterSettings } from '../server/core/defaults.ts';
import { isRecord } from '../server/core/is-record.ts';
import { HttpStatus, MODELS_BASE_URL } from '../server/core/wire.ts';
import { splitModelId } from '../server/models/naming.ts';
import { ModelFailure, openAiErrorBody } from '../server/models/openai-error.ts';
import type {
  AgentRouterPorts,
  Attribution,
  HostPool,
  HostProvider,
  HostServer,
  HostView,
  ModelsPort,
  SessionUser,
} from '../server/ports.ts';
import type { RunToolCall, ServedTool, ToolServices } from '../server/tools/api.ts';

// A host for the tests: a scripted model behind the models port, the stdio fixture (or any command) as the MCP
// servers behind the tools port, and a routing view held in memory. It stands in for ai-router's models and tools
// areas, which are not this package's.

/** One tool call the fake model makes. */
export interface ScriptCall {
  name: string;
  args: Record<string, unknown>;
}

/** What the fake model answers one request with. */
export interface Reply {
  content?: string;
  call?: ScriptCall;
  /** Several calls in one turn, each under the id `call_<n>`, from 1. */
  calls?: ScriptCall[];
}

/** One model call the host was asked to make. */
export interface ReceivedCall {
  body: Record<string, unknown>;
  headers: Record<string, string>;
  attribution: Attribution;
}

/** One tool call the host was asked to make for a run. */
export interface ReceivedToolCall {
  serverId: string;
  workspaceId: string | null;
  tool: string;
  args: Record<string, unknown>;
  /** The run it was for, as the host would record its activity under. */
  run: Pick<RunToolCall, 'agentId' | 'agentName' | 'runId' | 'workspaceId' | 'depth'> | undefined;
}

/** An MCP server the host has, and how it is started. */
export interface FakeServer extends HostServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** The fake provider's model and its context window. */
export const PROVIDER_NAME = 'fake';
export const PROVIDER_MODEL = 'm1';
export const PROVIDER_CONTEXT_LENGTH = 32_768;

/** What the fake model's usage reports for every answer. */
const USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

/**
 * Writes one answer as an OpenAI chat completion stream.
 *
 * @param reply - What the model says.
 * @returns The stream's text.
 */
export function sse(reply: Reply): string {
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    `data: ${JSON.stringify({ id: 'up', object: 'chat.completion.chunk', created: 0, model: PROVIDER_MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const parts: string[] = [];
  const calls = reply.calls ?? (reply.call === undefined ? [] : [reply.call]);
  if (calls.length > 0) {
    const toolCalls = calls.map((call, index) => ({
      index,
      // The same ids on every turn, as a server that counts from one does.
      id: `call_${index + 1}`,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.args) },
    }));
    if (reply.content !== undefined) {
      parts.push(chunk({ role: 'assistant', content: reply.content }, null));
    }
    parts.push(chunk({ role: 'assistant', tool_calls: toolCalls }, null), chunk({}, 'tool_calls'));
  } else {
    const content = reply.content ?? '';
    const half = Math.ceil(content.length / 2);
    parts.push(
      chunk({ role: 'assistant', content: content.slice(0, half) }, null),
      chunk({ content: content.slice(half) }, null),
    );
    parts.push(chunk({}, 'stop'));
  }
  parts.push(
    `data: ${JSON.stringify({ id: 'up', object: 'chat.completion.chunk', created: 0, model: PROVIDER_MODEL, choices: [], usage: USAGE })}\n\n`,
  );
  parts.push('data: [DONE]\n\n');
  return parts.join('');
}

/** A connection to one server, for one workspace, and the calls in flight on it. */
interface Instance {
  client: Client;
  /** The calls going now, by a key of the host's own, so a question goes to the only one. */
  inFlight: Map<string, RunToolCall | undefined>;
}

/** The host, for one test. */
export class FakeHost {
  readonly providers = new Map<string, HostProvider>([[PROVIDER_NAME, { name: PROVIDER_NAME, enabled: true }]]);
  readonly pools = new Map<string, HostPool>();
  readonly servers = new Map<string, FakeServer>();
  /** By workspace id: the ids of its servers. */
  readonly workspaceServers = new Map<string, string[]>();
  settings: Readonly<RouterSettings> = ROUTER_DEFAULTS;
  /** The model calls made, chat completions only, in order. */
  readonly received: ReceivedCall[] = [];
  /** The tool calls made, in order. */
  readonly toolCalls: ReceivedToolCall[] = [];
  /** Decides each answer of the fake model. */
  script: (body: Record<string, unknown>) => Reply = () => ({ content: 'hello' });
  /** What the lifecycle port was told was deleted, in order. */
  readonly deleted: { kind: 'workspace' | 'agent' | 'worker'; id: string }[] = [];
  /** What the lifecycle port was told was copied, in order. */
  readonly copied: { from: string; to: string; workspaceAgentIds: ReadonlyMap<string, string> }[] = [];
  /** When set, every lifecycle call records what it was told, then throws this. */
  lifecycleFailure: Error | null = null;
  /** Session tokens the people port knows. */
  readonly sessions = new Map<string, SessionUser>();
  private readonly instances = new Map<string, Promise<Instance>>();

  /**
   * Adds a server the host runs with a command, the stdio fixture by default.
   *
   * @param name - Its name.
   * @param command - What starts it.
   * @param args - Its arguments.
   * @param [env] - Its own env.
   * @returns The server.
   */
  addServer(name: string, command: string, args: string[], env: Record<string, string> = {}): FakeServer {
    const server: FakeServer = { id: randomUUID(), name, enabled: true, command, args, env };
    this.servers.set(name, server);
    return server;
  }

  /**
   * Puts a server in a workspace, unless it is there already.
   *
   * @param workspaceId - The workspace.
   * @param serverId - The server.
   */
  addToWorkspace(workspaceId: string, serverId: string): void {
    const ids = this.workspaceServers.get(workspaceId) ?? [];
    if (ids.includes(serverId) === false) {
      this.workspaceServers.set(workspaceId, [...ids, serverId]);
    }
  }

  /**
   * Reads the host's view, as the snapshot does.
   *
   * @returns The view now.
   */
  view(): HostView {
    return {
      providers: new Map(this.providers),
      pools: new Map(this.pools),
      servers: new Map(
        [...this.servers.values()].map(({ id, name, enabled }) => [name, { id, name, enabled }] as const),
      ),
      workspaceServers: new Map([...this.workspaceServers].map(([id, ids]) => [id, [...ids]] as const)),
      settings: this.settings,
    };
  }

  /** The models port: model calls answered by the script, in process. */
  readonly models: ModelsPort = {
    fetchFor: (attribution) => (input, init) => this.answerModelCall(attribution, input, init),
    contextLengthOf: async (providerName, model) =>
      providerName === PROVIDER_NAME && model === PROVIDER_MODEL ? PROVIDER_CONTEXT_LENGTH : null,
  };

  /** The tools port: each server's instance per workspace, a real MCP connection. */
  readonly tools: ToolServices = {
    listTools: async (serverId, workspaceId) => {
      const { client } = await this.instance(serverId, workspaceId);
      const { tools } = await client.listTools();
      return tools.map(
        (tool): ServedTool => ({
          name: tool.name,
          title: tool.title ?? null,
          description: tool.description ?? null,
          inputSchema: tool.inputSchema,
        }),
      );
    },
    callTool: async (serverId, workspaceId, tool, args, run) => {
      const instance = await this.instance(serverId, workspaceId);
      const attributed =
        run === undefined
          ? undefined
          : {
              agentId: run.agentId,
              agentName: run.agentName,
              runId: run.runId,
              workspaceId: run.workspaceId,
              depth: run.depth,
            };
      this.toolCalls.push({ serverId, workspaceId, tool, args, run: attributed });
      const callKey = randomUUID();
      instance.inFlight.set(callKey, run);
      try {
        const result = await instance.client.callTool({ name: tool, arguments: args }, undefined, {
          ...(run?.signal === undefined ? {} : { signal: run.signal }),
          ...(run?.onProgress === undefined
            ? {}
            : { onprogress: (progress) => run.onProgress?.({ message: progress.message ?? '' }) }),
        });
        return result as CallToolResult;
      } finally {
        instance.inFlight.delete(callKey);
      }
    },
  };

  /** All the ports, as `createAgentRouter` takes them. */
  ports(): AgentRouterPorts {
    return {
      models: this.models,
      tools: this.tools,
      readHostView: async () => this.view(),
      people: { sessionUser: async (headers) => this.sessionOf(headers) },
      lifecycle: {
        workspaceDeleted: async (id) => {
          this.deleted.push({ kind: 'workspace', id });
          this.workspaceServers.delete(id);
          this.failIfAsked();
        },
        agentDeleted: async (id) => {
          this.deleted.push({ kind: 'agent', id });
          this.failIfAsked();
        },
        workerDeleted: async (id) => {
          this.deleted.push({ kind: 'worker', id });
          this.failIfAsked();
        },
        workspaceCopied: async (from, to, workspaceAgentIds) => {
          this.copied.push({ from, to, workspaceAgentIds });
          // As ai-router copies its server entries: the new workspace has the same servers.
          this.workspaceServers.set(to, [...(this.workspaceServers.get(from) ?? [])]);
          this.failIfAsked();
        },
      },
    };
  }

  /**
   * Throws the lifecycle failure a test set.
   *
   * @throws {@link FakeHost.lifecycleFailure} when set.
   */
  private failIfAsked(): void {
    if (this.lifecycleFailure !== null) {
      throw this.lifecycleFailure;
    }
  }

  /** Closes every server's instance. */
  async stop(): Promise<void> {
    const instances = await Promise.allSettled(this.instances.values());
    this.instances.clear();
    for (const settled of instances) {
      if (settled.status === 'fulfilled') {
        await settled.value.client.close();
      }
    }
  }

  /**
   * Reads who a request's session token is.
   *
   * @param headers - The request's headers.
   * @returns The person, or null.
   */
  private sessionOf(headers: Headers): SessionUser | null {
    const token = (headers.get('authorization') ?? '').replace(/^bearer\s+/i, '');
    return this.sessions.get(token) ?? null;
  }

  /**
   * Answers one model call as the host's models area would: a known provider's model or pool, answered by the script.
   *
   * @param attribution - Who it counts under.
   * @param input - What the run's `fetch` was handed.
   * @param [init] - Its options.
   * @returns The answer, an OpenAI chat completion stream, or OpenAI's error envelope.
   */
  private async answerModelCall(
    attribution: Attribution,
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const request = new Request(input, init);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (request.url.startsWith(MODELS_BASE_URL) === false) {
      throw new Error(`The test host reaches only the router's models (${request.url}).`);
    }
    const path = request.url.slice(MODELS_BASE_URL.length);
    if (path === '/models') {
      return json(HttpStatus.Ok, { object: 'list', data: [{ id: `${PROVIDER_NAME}/${PROVIDER_MODEL}` }] });
    }
    const parsed: unknown = await request.json();
    const body = isRecord(parsed) ? parsed : {};
    const model = String(body.model ?? '');
    const split = splitModelId(model);
    const isKnown =
      split === null
        ? this.pools.get(model)?.enabled === true
        : this.providers.get(split.providerName)?.enabled === true && split.model === PROVIDER_MODEL;
    if (isKnown === false) {
      const { status } = ModelFailure.ModelNotFound;
      return json(status, openAiErrorBody(ModelFailure.ModelNotFound, `No model is named "${model}".`, 'model'));
    }
    // What the provider is sent: the model under its own id there, as the host's forwarding sends it.
    const upstreamModel = split?.model ?? this.pools.get(model)?.targets[0]?.model ?? model;
    this.received.push({
      body: { ...body, model: upstreamModel },
      headers: Object.fromEntries(request.headers),
      attribution,
    });
    return new Response(sse(this.script(body)), { headers: { 'content-type': 'text/event-stream' } });
  }

  /**
   * Finds or starts a server's instance for a workspace.
   *
   * @param serverId - The server.
   * @param workspaceId - The workspace, or null for the base instance.
   * @returns The instance.
   */
  private instance(serverId: string, workspaceId: string | null): Promise<Instance> {
    const key = `${serverId}/${workspaceId ?? ''}`;
    const known = this.instances.get(key);
    if (known !== undefined) {
      return known;
    }
    const server = [...this.servers.values()].find((candidate) => candidate.id === serverId);
    if (server === undefined) {
      return Promise.reject(new Error(`The test host has no server ${serverId}.`));
    }
    const started = (async (): Promise<Instance> => {
      const inFlight = new Map<string, RunToolCall | undefined>();
      const client = new Client({ name: 'test-host', version: '0.0.0' }, { capabilities: { elicitation: {} } });
      client.setRequestHandler(ElicitRequestSchema, async (question, extra) => {
        // The only call in flight asks it, as the host's tools area matches it; otherwise it is declined.
        const [only, ...others] = [...inFlight.values()];
        const onElicit = others.length === 0 ? only?.onElicit : undefined;
        return onElicit === undefined ? { action: 'decline' } : onElicit(question.params, { signal: extra.signal });
      });
      await client.connect(
        new StdioClientTransport({
          command: server.command,
          args: server.args,
          env: { PATH: process.env.PATH ?? '', ...server.env },
          stderr: 'ignore',
        }),
      );
      return { client, inFlight };
    })();
    this.instances.set(key, started);
    return started;
  }
}
