# [0.2.0](https://github.com/cubicecho/agent-router/compare/v0.1.0...v0.2.0) (2026-11-27)

### Features

* **worker:** publish the worker to npm as a library and a command ([de4d823](https://github.com/cubicecho/agent-router/commit/de4d823cdc1599411a5d594c33f2fc5f9dc62bb0))

# [0.1.0](https://github.com/cubicecho/agent-router/compare/v0.0.0...v0.1.0) (2026-11-27)

* feat(worker)!: name the worker agent-router-worker, with AGENT_ROUTER_* variables ([be5673c](https://github.com/cubicecho/agent-router/commit/be5673c0fa2ceb108ed9c7c4003626eb60fc6a9b))

### BREAKING CHANGES

* the worker reads AGENT_ROUTER_URL and AGENT_ROUTER_WORKER_KEY instead of AI_ROUTER_URL and
  AI_ROUTER_WORKER_KEY, and installs as agent-router-worker.
