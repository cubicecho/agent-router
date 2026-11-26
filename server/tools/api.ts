import type { RunEvent } from '@cubicecho/agent-core';
import type { CallToolResult, ElicitRequest, ElicitResult } from '@modelcontextprotocol/sdk/types.js';

/** One tool a server offers, as the host's tools area lists it. */
export interface ServedTool {
  name: string;
  title: string | null;
  description: string | null;
  inputSchema: unknown;
}

/** One thing a server said while a call ran. */
export type ToolProgress =
  /** A line of progress, from any server. */
  | { message: string; event?: undefined }
  /** A step of the agent run the call is, from a router's `/mcp`. */
  | { event: RunEvent; message?: undefined };

/**
 * Answers a question a server asks during a call.
 *
 * @param params - The question, as MCP's `elicitation/create` sends it.
 * @param options - `signal` aborts when the answer is no longer wanted.
 * @returns The answer. Rejecting is read as a decline.
 */
export type ToolElicit = (params: ElicitRequest['params'], options: { signal: AbortSignal }) => Promise<ElicitResult>;

/** The agent run a tool call is made for, which the host records its activity under. */
export interface RunToolCall {
  agentId: string;
  agentName: string;
  runId: string;
  /** The workspace whose run it is. The activity names it, even for a call on a server's base instance. */
  workspaceId: string;
  /** Abandons the call: the server is told it was cancelled. */
  signal?: AbortSignal;
  /** How many agents deep an agent the call starts would be: the run's own depth, plus one. */
  depth: number;
  /** Hears what the server says while the call runs. */
  onProgress?: (progress: ToolProgress) => void;
  /** Answers the server's questions. Absent, each is declined. */
  onElicit?: ToolElicit;
}

/**
 * The host's tools area, as agent runs use it: the tools of a server a run reaches, and calling one. The host's own
 * `ToolServices` has these two and more, so it is one as it is.
 */
export interface ToolServices {
  /**
   * Lists a server's tools, starting an instance if none runs.
   *
   * @param serverId - The server, as the host view names it.
   * @param workspaceId - The workspace whose instance to use; null for the server's base instance.
   * @returns Its tools.
   */
  listTools(serverId: string, workspaceId: string | null): Promise<ServedTool[]>;
  /**
   * Calls one tool for an agent run, and records the call.
   *
   * @param serverId - The server.
   * @param workspaceId - The workspace whose instance to use.
   * @param tool - The tool's own name on its server.
   * @param args - Its arguments.
   * @param [run] - The run it is for: its attribution, signal, progress and questions.
   * @returns What the tool answered.
   */
  callTool(
    serverId: string,
    workspaceId: string | null,
    tool: string,
    args: Record<string, unknown>,
    run?: RunToolCall,
  ): Promise<CallToolResult>;
}
