# AGENTS.md — agent-router

agent-router is ai-router's agent half, taken out as a **server package with no UI**: agents and their revisions,
runs, conversations, the agent loop, workspaces and workers. A host app mounts its routes, merges its GraphQL schema
with the others', applies its migrations, and hands it models and tools through ports.

- **The plan, the decisions and the order of work:** [`PLAN.md`](PLAN.md).
- **Where the code comes from:** `../ai-router`. Its `AGENTS.md`, `HOW-IT-WORKS.md` and `.agents/domain-model.md`
  describe the concepts and invariants this package keeps. ai-router stays the whole combination until it depends on
  this package.
- **How a cubicecho backend is built:** the `cubicecho_backend`, `cubicecho_typescript` and `coding-standards`
  skills. Load them before writing code.

## Layout

The same folders as ai-router's `server/`, so the host can switch to this package file for file.

| Folder | Holds | May import |
| --- | --- | --- |
| `server/core/` | config, defaults, wire constants, errors, validation, name rules, the settings' rules, this package's admin roles, callers and `AgentContext` | nothing here, except types for `context.ts` |
| `server/ports.ts` | what the host hands this package: models, tools, its routing view, people, lifecycle | `core`, `tools/api` |
| `server/db/` | the tables, their relations, the migration location, the snapshot slice | `core`, `ports` |
| `server/auth/` | workspace and worker keys, and reading callers | `core`, `db`, `ports` |
| `server/models/`, `server/tools/` | the small helpers agents use from the host's areas: model and tool naming, OpenAI errors, tool results, the narrowed `ToolServices` | `core` |
| `server/runner/` | the agent loop of one stretch of a run, from a JSON assignment, through its ports | `core` (a test keeps it so) |
| `server/workers/` | where a run's loop executes: `local` in process, and remote workers' registry, runs and doors | `core`, `db`, `auth`, `runner`, `models`, `agents/routes` (for express's body error words) |
| `server/agents/` | revisions, layers, reach, runs, conversations, `/v1`, `/runs`, `/mcp` | all of the above |
| `server/agent-router.ts` | the entry point a host calls | everything |
| `worker/` | the worker program, its local servers and the `workdir` server | `server/core`, `server/runner`, `server/auth/keys`, `server/tools` |
| `scripts/` | building the worker package | |
| `drizzle/` | this package's migrations, committed | |

## Rules that are easy to get wrong

ai-router's `AGENTS.md` holds the invariants this code keeps. These are the ones the split adds.

- **No foreign key to a host table.** A column naming a host row (`created_by`, a switch's `server_id`) is a plain
  column. Deleting a workspace, an agent or a worker tells the host through `ports.lifecycle`, after the commit.
- **Everything the host owns comes through `server/ports.ts`.** The snapshot takes the host's view on every rebuild;
  never read a host table.
- **Admin roles are this package's own** (`server/core/admin-roles.ts`). A run's caller carries every package's roles,
  and code here checks only its own.

## Commands

```bash
npm run check        # biome, tsc
npm test             # vitest, on PGlite with the real migrations
npm run db:generate  # the next migration after a table change; commit it
npm run worker       # the worker program, from this checkout
npm run pack:worker  # the worker package's tarball
```

## Git

- Conventional Commits.
- No `Co-Authored-By` trailers or other AI attribution.
- `npm run check && npm test` before every commit.
