# agent-router: the plan

agent-router is ai-router's agent half, taken out as a **server package with no UI**: agents and their
revisions, runs, conversations, the agent loop, workspaces and workers. It runs no process of its own. A host app
(ai-router, for now) applies its migrations, mounts its routes, merges its GraphQL schema with the others', and hands
it the models and tools it calls through ports.

ai-router stays the whole combination for now: this is a copy, and ai-router keeps its own code until it switches to
depending on this package. Later, llm-router and mcp-router can become packages of the same shape, and ai-router a
thin host that merges their finished schemas.

Status (2026-11-27): **steps 1 to 4 are built.** The runner, the worker program, the tables and their migration, the
snapshot slice, `agents/`, `workers/` and `workspaces/` behind the ports, the entry point, and the package's own
GraphQL schema with its permissions, with their tests on a test host.

**The MVP runs on its own** (step 4b): `server/standalone/` is a minimal host, booted by `server/index.ts` (`npm start`),
so agent-router serves `/graphql`, `/v1`, `/mcp`, `/runs` and `/workers` without ai-router. Integration with ai-router
(step 5) comes after.

## What moved here

The folders keep ai-router's names, so a host can switch to this package file for file.

| From ai-router | Here | Notes |
| --- | --- | --- |
| `server/agents/` | `server/agents/` | all of it |
| `server/runner/` | `server/runner/` | as it was |
| `server/workers/` | `server/workers/` | all of it |
| `server/workspaces/` | `server/workspaces/` | its keys, worker, copy and switches; a workspace's server entries stay with tools |
| the parts of `server/graphql/` these use | `server/graphql/` | building this package's schema, its abilities and permissions, write guards, database errors |
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
- **`people`:** who a request's session is, for the host's GraphQL caller (`readCaller`). Workspace and worker keys
  are checked here, against this package's own snapshot.
- **`lifecycle`:** told after a write commits, before the snapshot rebuild, so the host cleans up or copies its own
  rows in code. `workspaceDeleted`, `agentDeleted` and `workerDeleted` follow `deleteWorkspace`, `deleteAgent` and
  `deleteWorker`. `workspaceCopied(fromId, toId, workspaceAgentIds)` follows `copyWorkspace`, which copies only this
  package's rows, so the host copies its server entries; `workspaceAgentIds` maps each of the original's workspace
  agents to the copy's. A failure is logged with `[agent-router]` and the mutation still answers done: its rows are
  already written.

The entry point is `createAgentRouter({ db, ports, overrides?, workerOverrides?, runtime?, now?, snapshot?, workers? })`
in `server/agent-router.ts`. It returns the snapshot host, the run service, the routers for `/v1`, `/mcp`, `/runs`
and `/workers`, and `schema`. A host applies `AGENT_ROUTER_MIGRATIONS` and calls `upgradeStoredAgents(db)` before it.

The same file exports `buildAgentRouterSchema({ db, ports })` (the schema alone, from the database, `readHostView`
and `lifecycle`), the `AgentContext` type its resolvers read, and this package's admin roles and abilities
(`ADMIN_ROLES`, `FIELD_GRANTS`, `abilityFor`, `abilityForRoles`, `canReachField`) for the host's admin server to
union with the other packages'.

## GraphQL: one schema per package, merged by the host

Each package builds and exports **its own complete GraphQL schema**: `drizzle-graphql` over its own tables, its
hand-written fields, and its casl permissions. A host merges the finished schemas into the one it serves.

- This package's schema covers agents, revisions, runs, conversations, workers, workspaces, their agents, keys and
  per-agent switches.
- Its resolvers read what they need from `AgentContext` (`server/core/context.ts`): the database, the snapshot host,
  the run service, the caller, and the request, whose abort stops a subscription. A host's context carries this and
  more.
- **Its permissions travel with it.** They are applied inside `buildAgentRouterSchema`, so a host that stitches the
  schema keeps them (`tests/graphql/merged.test.ts`). Nothing here is admin-only; people-only mutations are listed in
  `server/graphql/permissions.ts`, and a run reaches only `FIELD_GRANTS` by its roles, reading only this package's.
- **Fields across packages go away** in the merged schema: `Workspace.serversAggregate`, a revision's, key's or
  worker's `creator` (`createdBy` stays, as a plain id), and filters through a workspace's servers. The host adds them
  back in its links layer (ai-router#75), and its UI queries are rewritten until then.
- **What the host's handler keeps:** Yoga, the operation's depth, alias and cost limits, and the SSE transport of the
  subscription. This package caps only its list sizes (`OPERATION_LIMIT_DEFAULTS`).

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
4. The package's own GraphQL schema: `agents/resolvers.ts`, `run-resolvers.ts`, `workers/resolvers.ts`,
   `workspaces/`, the write guards and hooks, casl permissions, and the deletes and the copy that call `lifecycle`. A
   small host in the tests stitches it with a stand-in. **Done.**
4b. The MVP: a standalone host in this package, so it runs on its own. Its ports are as small as they can be: models
   are providers from `AGENT_ROUTER_PROVIDERS` (no pools, usage or health); there are no router MCP servers, so tools
   come only from workers' local servers; people are one admin, on `SECURE_LOCAL_NET` or `AGENT_ROUTER_ADMIN_TOKEN`;
   lifecycle calls are logged no-ops. An HTTP test (`tests/standalone/`) runs an agent on `/v1`, streamed and not, and
   on a remote worker calling a tool on its own server. **Done.**
5. Later, in ai-router: depend on this package, delete the copies, implement the ports over its own areas, and compare
   the merged schema with today's.

## Left over from step 4

- **`cancelRun` without a reason says "Cancelled by a person."** It named the person in ai-router, from the users
  table, which is the host's. A `people` lookup of a name would bring it back, if it is missed.
- **Elicitation, the admin server, agents calling agents and workspace instances keep their tests in ai-router**, as
  in step 3: they need its tools area.
- **drizzle-graphql warns at build** that `workspaceKeys.hash` is excluded and required. Its inserts are reserved, so
  no generated insert exists; ai-router's build says the same.

## The standalone host (step 4b)

`server/standalone/` is a host like any other, and the only code here that reads the environment. ai-router never
runs it: it mounts the package and supplies its own ports. What it leaves out is ai-router's: accounts and roles,
pools, balancing, usage, prices, provider health, router MCP servers, installs, secrets, the admin server, the UI and
rate limiting. Its advisory lock is `agent-router`, not ai-router's, so the two never share a database by accident.
