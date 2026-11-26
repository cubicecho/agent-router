# agent-router: the plan

agent-router is ai-router's agent half, taken out as a **server package with no UI**: agents and their
revisions, runs, conversations, the agent loop, workspaces and workers. It runs no process of its own. A host app
(ai-router, for now) applies its migrations, mounts its routes, merges its GraphQL schema with the others', and hands
it the models and tools it calls through ports.

ai-router stays the whole combination for now: this is a copy, and ai-router keeps its own code until it switches to
depending on this package. Later, llm-router and mcp-router can become packages of the same shape, and ai-router a
thin host that merges their finished schemas.

Status (2026-11-25): **steps 1 to 3 are built.** The runner, the worker program, the tables and their migration, the
snapshot slice, `agents/` and `workers/` behind the ports, and the entry point, with their tests on a test host. Next
is step 4, the GraphQL schema.

## What moved here

The folders keep ai-router's names, so a host can switch to this package file for file.

| From ai-router | Here | Notes |
| --- | --- | --- |
| `server/agents/` | `server/agents/` | all but `resolvers.ts`, `run-resolvers.ts` and `hooks.ts`, which are GraphQL (step 4) |
| `server/runner/` | `server/runner/` | as it was |
| `server/workers/` | `server/workers/` | all but `resolvers.ts` (step 4) |
| `worker/`, `scripts/worker-package.ts` | `worker/`, `scripts/` | the worker program and its package |
| the agent tables | `server/db/tables/` | `agents`, `agent_revisions`, `runs`, `run_events`, `conversations`, `workers`, `workspaces`, `workspace_agents`, `workspace_keys` and the two per-agent switch tables |
| `server/auth/caller.ts`, `keys.ts` | `server/auth/` | keys and callers; a person's session through the people port |
| the helpers agents used from `models/` and `tools/` | `server/models/`, `server/tools/` | `naming.ts`, `openai-error.ts`, `SESSION_HEADER`, tool naming and results, and the narrowed `ToolServices` |
| the parts of `server/core/` these use | `server/core/` | copied, not shared, until a common package earns its keep |
| their tests | `tests/` | on a test host (`tests/fake-host.ts`): a scripted model, and the stdio fixture behind the tools port |

## What stays in the host

- **Models:** providers, pools, the balancer, forwarding, usage, prices.
- **Tools:** MCP servers, installs, instances, `run-as-child`, secrets, workspace server entries, activity.
- **People:** better-auth, users, sessions, SSO, user roles, the router's settings row.
- **The UI,** the admin server, and merging the packages' GraphQL schemas.

## The ports: what the host hands agent-router

All of them are in `server/ports.ts`, as `AgentRouterPorts`.

- **`models`:** `fetchFor(attribution)`, the `fetch` a run's model calls go through, and `contextLengthOf(provider,
  model)` for an agent's `/v1/models` entry.
- **`tools`:** `listTools` and `callTool`, the two parts of the host's `ToolServices` a run uses. Questions
  (elicitation) and progress ride on the call's `RunToolCall`.
- **`readHostView`:** the host's providers, pools and servers by name, each workspace's server ids, and the router's
  settings. The snapshot reads it on every rebuild, so the host rebuilds after its own writes that change it.
- **`people`:** who a request's session is, for the GraphQL caller (step 4). Workspace and worker keys are checked
  here, against this package's own snapshot.
- **`lifecycle`:** told after a delete commits that a workspace, an agent or a worker is gone, so the host cleans up
  its own rows in code. Nothing in step 3 deletes one: step 4's mutations call it.

The entry point is `createAgentRouter({ db, ports, overrides?, workerOverrides?, runtime?, now?, snapshot?, workers? })`
in `server/agent-router.ts`. It returns the snapshot host, the run service, and the routers for `/v1`, `/mcp`,
`/runs` and `/workers`. A host applies `AGENT_ROUTER_MIGRATIONS` and calls `upgradeStoredAgents(db)` before it.

## GraphQL: one schema per package, merged by the host

Each package builds and exports **its own complete GraphQL schema**: `drizzle-graphql` over its own tables, its
hand-written fields, and its casl permissions. A host merges the finished schemas into the one it serves.

- This package's schema covers agents, revisions, runs, conversations, workers, workspaces, their agents, keys and
  per-agent switches.
- Its resolvers read what they need from `AgentContext` (`server/core/context.ts`): the database, the snapshot host,
  the run service and the caller. A host's context carries this and more.
- **Fields across packages go away** in the merged schema: `Workspace.serversAggregate`, a revision's or key's
  `creator`, and filters through a workspace's servers. The host's UI queries are rewritten for that later.

## Decisions (2026-11-25)

1. **agent-router owns workspaces,** `workspace_agents`, `workspace_keys`, a workspace's worker and the per-agent
   switches. `workspace_servers` stays with tools.
2. **TypeScript source, run on Node 26** with no build step. ai-router depends on it as a `file:` dependency, later
   from git or a registry.
3. **Each package ships its own Drizzle migrations** (`drizzle/`, committed), recorded in a table of its own
   (`__agent_router_migrations`). A host applies each package's set with its own driver.
4. **Each package builds its own complete GraphQL schema, and the host merges the finished schemas** (graphql-tools
   style). Relation fields across packages go away. An ai-router issue tracks looking at a module-based composition
   instead.
5. **No foreign key crosses packages, and cleanup is done in code.** A column that points at a host row (`created_by`
   at a user, a switch's `server_id`) is a plain column. When agent-router deletes a workspace, an agent or a worker,
   it tells the host through the `lifecycle` port, after the commit and beside the snapshot rebuild, and the host
   cleans its own rows. The host likewise deletes the switch rows of a server it deletes or takes out of a workspace.
6. **Each package declares the admin-server roles its own fields need, and the host unions them.** This package owns
   `agents:read`, `agents:manage` and `runs:read` (`server/core/admin-roles.ts`). A run's caller carries every
   package's roles as strings, and this package reads only its own.

## Order of work

1. The scaffold: package.json, tsconfig, Biome, Vitest, and the `core` subset. **Done.**
2. `runner/` and `worker/`, which move almost as they are. **Done.**
3. The tables and their migration, the snapshot slice, then `agents/` and `workers/` behind the ports, with their tests
   on a test host. **Done.**
4. The package's own GraphQL schema: `agents/resolvers.ts`, `run-resolvers.ts`, `workers/resolvers.ts`, the write
   guards and hooks, casl permissions, and the deletes that call `lifecycle`. A small host in the tests merges it with
   a stand-in.
5. Later, in ai-router: depend on this package, delete the copies, implement the ports over its own areas, and compare
   the merged schema with today's.
