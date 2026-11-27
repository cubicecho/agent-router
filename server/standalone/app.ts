import type { Server } from 'node:http';
import { sql } from 'drizzle-orm';
import express, { type Express } from 'express';
import { type AgentRouter, createAgentRouter } from '../agent-router.ts';
import { version } from '../core/config.ts';
import { errorMessage } from '../core/errors.ts';
import { HttpStatus, MS_PER_SECOND } from '../core/wire.ts';
import type { DB } from '../db/client.ts';
import type { AgentRouterPorts } from '../ports.ts';
import { WORKERS_PATH } from '../runner/protocol.ts';
import type { StandaloneConfig } from './config.ts';
import { createStandaloneGraphQL } from './graphql.ts';
import { createStandaloneModels } from './models.ts';
import { createStandalonePorts } from './ports.ts';

// agent-router on its own: its routes and schema mounted on one Express app, over the standalone host's ports.

/** The largest /graphql body. Over it: 413. */
const GRAPHQL_BODY_LIMIT = '1mb';
/** How long requests in flight get at shutdown before their sockets are closed. */
const DRAIN_SECONDS = 5;

/** What the standalone app is built from. Tests pass PGlite and their own provider `fetch`. */
export interface StandaloneAppDeps {
  /** The database, claimed and migrated, with stored agents upgraded. */
  db: DB;
  config: Pick<StandaloneConfig, 'providers' | 'secureLocalNet' | 'adminToken' | 'isProduction'>;
  /** How providers are reached. */
  upstream?: typeof globalThis.fetch;
  /** Where the lifecycle port's notes go. */
  log?: (message: string) => void;
}

/** The app, not listening, and the agent-router behind it. */
export interface StandaloneApp {
  app: Express;
  router: AgentRouter;
  ports: AgentRouterPorts;
}

/**
 * Builds the standalone app: /graphql, /v1, /mcp, /runs, /workers and /healthz.
 *
 * @param deps - The database and config.
 * @returns The app. It does not listen, and starts no run timers: the boot does both.
 */
export async function createStandaloneApp({ db, config, upstream, log }: StandaloneAppDeps): Promise<StandaloneApp> {
  const models = createStandaloneModels(config.providers, upstream);
  const ports = createStandalonePorts(models, config.adminToken, log);
  const router = await createAgentRouter({ db, ports });
  const graphql = createStandaloneGraphQL({
    db,
    router,
    people: ports.people,
    secureLocalNet: config.secureLocalNet,
    isProduction: config.isProduction,
  });

  const app = express();
  app.disable('x-powered-by');
  // Yoga reads a body Express already parsed, so the size cap goes here.
  app.use(graphql.graphqlEndpoint, express.json({ limit: GRAPHQL_BODY_LIMIT }));
  // `all`, not `use`: a mounted `use` strips the path, and Yoga matches graphqlEndpoint itself.
  app.all(graphql.graphqlEndpoint, (request, response) => graphql(request, response));
  app.use('/v1', router.routes.v1);
  app.use('/mcp', router.routes.mcp);
  app.use('/runs', router.routes.runs);
  app.use(WORKERS_PATH, router.routes.workers);
  app.get('/healthz', async (_request, response) => {
    try {
      await db.execute(sql`select 1`);
      response.json({ ok: true, version: version() });
    } catch (error) {
      response
        .status(HttpStatus.ServiceUnavailable)
        .json({ ok: false, version: version(), error: errorMessage(error) });
    }
  });
  return { app, router, ports };
}

/**
 * Stops accepting connections, and resolves once every request has finished or {@link DRAIN_SECONDS} have passed.
 *
 * @param server - The HTTP server.
 */
export function drain(server: Server): Promise<void> {
  return new Promise((resolve) => {
    const cutoff = setTimeout(() => server.closeAllConnections(), DRAIN_SECONDS * MS_PER_SECOND);
    server.close(() => {
      clearTimeout(cutoff);
      resolve();
    });
    // Idle keep-alive sockets, and a worker's channel, wait on nothing the drain needs.
    server.closeIdleConnections();
  });
}
