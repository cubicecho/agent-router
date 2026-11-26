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
| `server/core/` | config, defaults, wire constants, errors, validation, name rules | nothing here |
| `server/auth/` | workspace and worker keys | `core` |
| `server/tools/` | the exact-env stdio transport and tool-result helpers the worker uses | `core` |
| `server/runner/` | the agent loop of one stretch of a run, from a JSON assignment, through its ports | `core` (a test keeps it so) |
| `worker/` | the worker program, its local servers and the `workdir` server | `server/core`, `server/runner`, `server/auth/keys`, `server/tools` |
| `scripts/` | building the worker package | |

## Commands

```bash
npm run check        # biome, tsc
npm test             # vitest
npm run worker       # the worker program, from this checkout
npm run pack:worker  # the worker package's tarball
```

## Git

- Conventional Commits.
- No `Co-Authored-By` trailers or other AI attribution.
- `npm run check && npm test` before every commit.
