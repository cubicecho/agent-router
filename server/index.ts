import { upgradeStoredAgents } from './agent-router.ts';
import { errorMessage } from './core/errors.ts';
import { MS_PER_SECOND } from './core/wire.ts';
import { createStandaloneApp, drain } from './standalone/app.ts';
import { readStandaloneConfig, type StandaloneConfig } from './standalone/config.ts';
import { openStandaloneDatabase } from './standalone/database.ts';

// Boot for agent-router on its own, with the standalone host's minimal ports. A host that mounts the package (ai-router,
// later) never runs this file.

/** Every interface. A container's port mapping decides who can reach it. */
const LISTEN_HOST = '0.0.0.0';
/** What an orchestrator, or Ctrl-C, sends to ask for a stop. */
const STOP_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
/** The whole stop is held under this: Docker sends SIGKILL ten seconds after SIGTERM. */
const SHUTDOWN_DEADLINE_SECONDS = 9;

let config: StandaloneConfig;
try {
  config = readStandaloneConfig();
} catch (error) {
  console.error(`[config] ${errorMessage(error)}`);
  process.exit(1);
}

const database = openStandaloneDatabase(config.databaseUrl);
console.log(`[db] ${database.location}`);
try {
  await database.waitUntilUp();
  // Before migrating: a second agent-router on the same database stops here, not racing this one.
  await database.claim();
  await database.migrate();
  await upgradeStoredAgents(database.db);
} catch (error) {
  console.error(`[db] ${errorMessage(error)}`);
  await database.close().catch(() => {});
  process.exit(1);
}

const { app, router } = await createStandaloneApp({ db: database.db, config });
// Before listening, so a retried request never finds a run that nothing is running.
const recovered = await router.runs.recover();
if (recovered > 0) {
  console.warn(`[runs] ${recovered} runs were going when agent-router stopped; they are marked failed.`);
}
router.runs.start();

const server = app.listen(config.port, LISTEN_HOST, () => {
  console.log(`[server] ready on port ${config.port}`);
  const names = config.providers.map(({ name }) => name);
  if (names.length === 0) {
    console.warn('[models] AGENT_ROUTER_PROVIDERS names no provider, so no agent can run.');
  } else {
    console.log(`[models] providers: ${names.join(', ')}`);
  }
  if (config.secureLocalNet) {
    console.warn(
      '[auth] SECURE_LOCAL_NET is on: every /graphql request without a key is the admin. Apps still need one.',
    );
  } else if (config.adminToken === null) {
    console.warn(
      '[auth] Nobody can use /graphql: set AGENT_ROUTER_ADMIN_TOKEN, or SECURE_LOCAL_NET on a private network.',
    );
  }
});

let isStopping = false;

/**
 * Stops cleanly: drain the requests in flight, end the runs still going, release the database.
 *
 * @param signal - What asked for the stop.
 */
async function stop(signal: NodeJS.Signals): Promise<void> {
  if (isStopping) {
    process.exit(1);
  }
  isStopping = true;
  console.log(`[shutdown] ${signal} received. Finishing requests in flight.`);
  setTimeout(() => {
    console.error(`[shutdown] Not finished after ${SHUTDOWN_DEADLINE_SECONDS} s. Exiting anyway.`);
    process.exit(1);
  }, SHUTDOWN_DEADLINE_SECONDS * MS_PER_SECOND).unref();
  await drain(server);
  await router.runs.stop();
  await database.close();
  console.log('[shutdown] Stopped.');
  process.exit(0);
}

for (const signal of STOP_SIGNALS) {
  process.on(signal, (received) => {
    stop(received).catch((error: unknown) => {
      console.error('[shutdown] Failed while stopping.', error);
      process.exit(1);
    });
  });
}
