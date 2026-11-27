# agent-router

ai-router's agent half as a server package with no UI: agents and their revisions, runs, conversations, the agent
loop, workspaces and workers. A host mounts it and hands it models and tools through ports (`server/ports.ts`). The
plan is in [`PLAN.md`](PLAN.md), the working rules in [`AGENTS.md`](AGENTS.md).

## Run it on its own

The package carries a minimal host of its own (`server/standalone/`, booted by `server/index.ts`), so it runs without
ai-router. It's an MVP: what it leaves out is under "What the standalone host doesn't do" below.

```bash
npm install
npm run db:up        # a Postgres for development, on 127.0.0.1:5441
DATABASE_URL=postgres://agents:agents@127.0.0.1:5441/agents \
AGENT_ROUTER_PROVIDERS='[{"name":"ollama","baseUrl":"http://ollama.lan:11434/v1"}]' \
SECURE_LOCAL_NET=1 \
npm start            # or `npm run dev`, which restarts on a change
```

At boot it waits for Postgres, takes an advisory lock (a second agent-router on the same database refuses to start),
applies its migrations and upgrades stored agents. It then serves:

| Path | Who | What |
| --- | --- | --- |
| `/graphql` | the admin | agents, revisions, workspaces, their keys, workers, runs. GraphiQL unless `NODE_ENV=production` |
| `/v1` | a workspace key | the agents endpoint, OpenAI-compatible |
| `/mcp` | a workspace key | the same agents as MCP tools |
| `/runs` | a workspace key | that workspace's run records and events |
| `/workers` | a worker key | the worker doors |
| `/healthz` | anyone | whether the database answers |

### Environment

| Variable | | |
| --- | --- | --- |
| `DATABASE_URL` | required | a `postgres://` URL |
| `PORT` | `3100` | where it listens, on every interface |
| `AGENT_ROUTER_PROVIDERS` | none | a JSON list of OpenAI-compatible providers: `[{"name":"llm","baseUrl":"http://…/v1","apiKey":"…"}]`. `apiKey` is optional, and goes only to its own provider |
| `SECURE_LOCAL_NET` | off | `1`: every `/graphql` request that presents no key is the admin. Only on a private network. Apps still need a workspace key |
| `AGENT_ROUTER_ADMIN_TOKEN` | none | a token that is the admin on `/graphql`, sent as `Authorization: Bearer` |
| `NODE_ENV` | | `production` turns GraphiQL and introspection off |

With neither `SECURE_LOCAL_NET` nor `AGENT_ROUTER_ADMIN_TOKEN`, nobody can use `/graphql`.

An agent's document names its model as `<provider>/<model>`, such as `ollama/qwen3:8b`. The call goes to that
provider's `baseUrl` under the model's own id there.

### Set up an agent and a key

With `SECURE_LOCAL_NET=1` no header is needed. With a token, add `-H "authorization: Bearer $AGENT_ROUTER_ADMIN_TOKEN"`.

```bash
gql() { curl -s localhost:3100/graphql -H 'content-type: application/json' -d "$1"; echo; }

gql '{"query":"mutation ($d: JSON!) { createAgent(document: $d) { id } }",
      "variables":{"d":{"spec":"cubicecho.agent/2","id":"helper","name":"Helper",
        "model":{"model":"ollama/qwen3:8b"},
        "prompt":[{"role":"system","name":"identity","content":"You are brief and helpful."}]}}}'
# → {"data":{"createAgent":{"id":"<agent id>"}}}

gql '{"query":"mutation { createWorkspace(values: { slug: \"my-app\", name: \"My app\" }) { id } }"}'
# → {"data":{"createWorkspace":{"id":"<workspace id>"}}}

gql '{"query":"mutation ($v: CreateWorkspaceAgentInput!) { createWorkspaceAgent(values: $v) { id } }",
      "variables":{"v":{"workspaceId":"<workspace id>","agentId":"<agent id>"}}}'

gql '{"query":"mutation ($w: UUID!) { createWorkspaceKey(workspaceId: $w, name: \"my-app\") { secret } }",
      "variables":{"w":"<workspace id>"}}'
# → {"data":{"createWorkspaceKey":{"secret":"air_…"}}}   shown once
```

### Call it

```bash
curl -s localhost:3100/v1/chat/completions \
  -H "authorization: Bearer air_…" -H 'content-type: application/json' \
  -d '{"model":"helper","messages":[{"role":"user","content":"Say hello."}]}'

curl -s localhost:3100/v1/models -H "authorization: Bearer air_…"
curl -s localhost:3100/runs/<X-Run-Id from the answer> -H "authorization: Bearer air_…"
```

### Tools come from workers

The standalone host has **no MCP servers of its own**: a run on the built-in `local` worker has no tools. To give
agents tools, make a worker and put the workspace on it. Its local servers are the runs' tools.

```bash
gql '{"query":"mutation { createWorker(name: \"box\") { secret worker { id } } }"}'
gql '{"query":"mutation ($w: UUID!, $k: UUID) { setWorkspaceWorker(workspaceId: $w, workerId: $k) { id } }",
      "variables":{"w":"<workspace id>","k":"<worker id>"}}'

# On the machine with the tools; WORKER_CONFIG names its servers ({"servers":{"name":{"command":…}}}).
AGENT_ROUTER_URL=http://agent-router.lan:3100 AGENT_ROUTER_WORKER_KEY=aiw_… WORKER_CONFIG=./worker.json npm run worker
```

### Images

A release pushes two images to GHCR, and attaches the worker package's tarball to the GitHub release:

- `ghcr.io/cubicecho/agent-router`: the standalone host. `docker compose up` runs it beside its own Postgres, on port
  3100; `.env.example` lists what it reads.
- `ghcr.io/cubicecho/agent-router-worker` (amd64 and arm64): the worker program, with its work directories on `/work`.
- `cubicecho-agent-router-worker-<version>.tgz`: the same worker, for `npm i -g <its URL>`.

### What the standalone host doesn't do

- **People:** there are no accounts, only the admin, and so no roles beyond it.
- **Models:** no pools, no balancing, no usage or price records, no provider health checks.
- **Tools:** the router runs no MCP server. There are no installs, instances, secrets or admin server.
- **The rest:** no UI and no rate limiting.

Those are ai-router's, and come back when ai-router mounts this package.
