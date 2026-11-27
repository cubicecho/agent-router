import { timingSafeEqual } from 'node:crypto';
import { ROUTER_DEFAULTS } from '../core/defaults.ts';
import type { AgentRouterPorts, HostView, PeoplePort, SessionUser } from '../ports.ts';
import { Role } from '../ports.ts';
import type { ToolServices } from '../tools/api.ts';
import type { StandaloneModels } from './models.ts';

// The standalone host's other ports, as small as a host can be: no people but one admin, no router MCP servers, and
// nothing of its own to clean up when agent-router deletes or copies a row.

/**
 * The one person the standalone host has: the admin, on the trusted network or with the admin token. A fixed id, so
 * what they create says the same `createdBy` across restarts.
 */
export const STANDALONE_ADMIN: Readonly<SessionUser> = Object.freeze({
  userId: '00000000-0000-4000-8000-00000000a0a0',
  role: Role.Admin,
});

/** The scheme the admin token is sent under. */
const BEARER_SCHEME = /^bearer\s+/i;

/**
 * Compares two strings in constant time.
 *
 * @param given - What the request sent.
 * @param expected - The token.
 * @returns Whether they are the same.
 */
function isSameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Builds the people port: the admin token, sent as a Bearer, is the admin; nothing else is anybody.
 *
 * @param adminToken - The token, or null for none.
 * @returns The port.
 *
 * @remarks
 * The trusted network's sign-in is the handler's, not this port's: it applies to a request that presents nothing,
 * and agent-router only asks the port about a Bearer value that is not a key.
 */
export function createStandalonePeople(adminToken: string | null): PeoplePort {
  return {
    sessionUser: async (headers) => {
      const authorization = headers.get('authorization') ?? '';
      if (adminToken === null || BEARER_SCHEME.test(authorization) === false) {
        return null;
      }
      return isSameToken(authorization.replace(BEARER_SCHEME, '').trim(), adminToken) ? { ...STANDALONE_ADMIN } : null;
    },
  };
}

/** Thrown for a call to a router server: this host has none. */
const NO_ROUTER_SERVERS =
  'This standalone host has no MCP servers of its own. Run the workspace on a worker, whose local servers the runs use.';

/** The tools port: there are no router servers, so nothing names one, and a call that somehow does is refused. */
const NO_TOOLS: ToolServices = {
  listTools: async () => {
    throw new Error(NO_ROUTER_SERVERS);
  },
  callTool: async () => {
    throw new Error(NO_ROUTER_SERVERS);
  },
};

/**
 * Builds the routing view the standalone host hands every snapshot: its providers, and no pools or servers.
 *
 * @param models - The standalone models.
 * @returns The view, the same on every read.
 */
export function standaloneHostView(models: StandaloneModels): HostView {
  return {
    providers: models.providers,
    pools: new Map(),
    servers: new Map(),
    workspaceServers: new Map(),
    settings: ROUTER_DEFAULTS,
  };
}

/**
 * Builds every port the standalone host hands agent-router.
 *
 * @param models - The standalone models.
 * @param adminToken - The admin token, or null.
 * @param [log] - Where the lifecycle calls are noted.
 * @returns The ports.
 */
export function createStandalonePorts(
  models: StandaloneModels,
  adminToken: string | null,
  log: (message: string) => void = console.log,
): AgentRouterPorts {
  const view = standaloneHostView(models);
  return {
    models: models.port,
    tools: NO_TOOLS,
    readHostView: async () => view,
    people: createStandalonePeople(adminToken),
    // Nothing of the host's hangs off agent-router's rows here, so there is nothing to clean up or copy.
    lifecycle: {
      workspaceDeleted: async (id) => log(`[host] workspace ${id} deleted; nothing of the host's to clean up.`),
      agentDeleted: async (id) => log(`[host] agent ${id} deleted; nothing of the host's to clean up.`),
      workerDeleted: async (id) => log(`[host] worker ${id} deleted; nothing of the host's to clean up.`),
      workspaceCopied: async (from, to) =>
        log(`[host] workspace ${from} copied to ${to}; nothing of the host's to copy.`),
    },
  };
}
