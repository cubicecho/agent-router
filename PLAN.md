# agent-router: the plan

agent-router is ai-router's agent half, taken out as a **server package with no UI**: agents and their
revisions, runs, conversations, the agent loop, and workers. It runs no process of its own. A host app (ai-router,
for now) mounts its routes, adds its tables and GraphQL to the host's, and hands it the models and tools it calls
through ports.

ai-router stays the whole combination for now: this is a copy, and ai-router keeps its own code until it switches to
depending on this package. Later, llm-router and mcp-router can become packages of the same shape, and ai-router a
thin host that merges the three schemas back into the one it serves today.

Status: **decided, being built** (2026-11-25).

## What moves here

| From ai-router | Here | Notes |
| --- | --- | --- |
| `server/agents/` | `src/agents/` | revisions, layers, reach, runs, conversations, `/v1`, `/runs`, `/mcp` |
| `server/runner/` | `src/runner/` | already depends only on `core` |
| `server/workers/` | `src/workers/` | workers, worker keys, the doors under `/workers` |
| `worker/`, `scripts/worker-package.ts` | `worker/`, `scripts/` | the worker program and its package |
| the agent tables | `src/db/tables/` | `agents`, `agent_revisions`, `runs`, `run_events`, `conversations`, `workers`, and the workspace tables below |
| the parts of `server/core/` these use | `src/core/` | errors, wire constants, name rules, defaults. Copied, not shared, until a common package earns its keep |
| their tests | `tests/` | with a harness that fakes the ports, not a real models or tools area |

## What stays in the host

- **Models:** providers, pools, the balancer, forwarding, usage, prices.
- **Tools:** MCP servers, installs, instances, `run-as-child`, secrets, workspace server entries.
- **People:** better-auth, users, sessions, SSO, roles, the router's settings.
- **The UI,** the admin server, and building the one GraphQL schema.

## The ports: what the host hands agent-router

- **Models:** the `Forwarder` a run's `fetch` goes through, and the catalogue that context lengths come from.
- **Tools:** `ToolServices`, which gives the servers and tools a run reaches, calls them, and handles questions.
- **Callers:** reading a user's session. Workspace keys and worker keys are checked here, against this package's own
  snapshot slice.
- **Snapshot:** this package builds its own slice (agents, workspaces, keys, workers). The host rebuilds it after
  every commit, as now.

The helpers it imports today (`splitModelId`, `toolName`, `splitToolName`, `openAiErrorBody`, the tool-result
helpers, `SESSION_HEADER`) are small, and are copied here.

## GraphQL: one schema per package, merged by the host

Each package builds and exports **its own complete GraphQL schema**: `drizzle-graphql` over its own tables, its
hand-written fields, and its casl permissions. A host merges the packages' schemas into the one it serves.

- This package's schema covers agents, revisions, runs, conversations, workers, workspaces, their agents, keys and
  per-agent switches.
- Its resolvers read what they need from a context type declared here (`AgentContext`): the caller, its roles, the
  snapshot slice, and the database. A host's context must satisfy it.
- **Ties across packages,** such as a workspace's server entries (the tools side) pointing at a workspace (here), are
  left for later. The merged schema starts with each package's types side by side.

## Decisions (2026-11-25)

1. **agent-router owns workspaces,** `workspace_agents`, `workspace_keys`, a workspace's worker and the per-agent
   switches, which name servers and tools as plain strings. `workspace_servers` stays with tools.
2. **TypeScript source, run on Node 26** with no build step. ai-router depends on it as a `file:` dependency, later
   from git or a registry.
3. **Each package ships its own Drizzle migrations** (`drizzle/`, committed), and a host applies each package's set.
   Foreign keys don't cross packages yet: a tie across domains is kept as a plain id until that design is settled.
4. **The host merges the packages' GraphQL schemas** into one, rather than this package handing over raw tables.

## Order of work

1. The scaffold: package.json, tsconfig, Biome, Vitest, and the `core` subset.
2. `runner/` and `worker/`, which move almost as they are.
3. The tables and the snapshot slice, then `agents/` and `workers/` behind the ports, with their tests on faked ports.
4. The package's own GraphQL schema and migrations, and a small host in the tests that merges it with a stand-in.
5. Later, in ai-router: depend on this package, delete the copies, and compare the merged schema with today's.
