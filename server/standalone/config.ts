import { z } from 'zod';
import { nameSchema } from '../core/names.ts';

// The standalone host's environment, read once at boot. The package itself reads none of it: this is the host.

/** The port it listens on when `PORT` is unset. */
const DEFAULT_PORT = 3100;
/** The highest TCP port. */
const MAX_PORT = 65_535;

/** One OpenAI-compatible provider the host forwards a run's model calls to. */
const providerSchema = z.strictObject({
  /** As an agent's document names its model: `<name>/<model>`. */
  name: nameSchema("A provider's name"),
  /** Its OpenAI-compatible base URL, such as `http://ollama.lan:11434/v1`. */
  baseUrl: z.url('A provider\'s "baseUrl" must be an absolute URL, such as "http://ollama.lan:11434/v1".'),
  /** Sent to it, and only it, as `Authorization: Bearer`. */
  apiKey: z.string().min(1).optional(),
});
export type ProviderConfig = z.infer<typeof providerSchema>;

/** Reads a JSON list of providers, and refuses two with one name. */
const providersSchema = z
  .string()
  .transform((text, context): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      context.addIssue({ code: 'custom', message: 'AGENT_ROUTER_PROVIDERS must be a JSON list.' });
      return z.NEVER;
    }
  })
  .pipe(z.array(providerSchema))
  .refine((providers) => new Set(providers.map(({ name }) => name)).size === providers.length, {
    message: 'AGENT_ROUTER_PROVIDERS names one provider twice.',
  });

/** An env flag: `1` or `true` is on. */
const flagSchema = z
  .string()
  .optional()
  .transform((value) => value === '1' || value?.toLowerCase() === 'true');

const envSchema = z.object({
  DATABASE_URL: z
    .string({ error: 'DATABASE_URL is required: a postgres:// URL. `npm run db:up` starts one on 127.0.0.1:5441.' })
    .refine((value) => /^postgres(ql)?:\/\//.test(value), 'DATABASE_URL must be a postgres:// URL.'),
  PORT: z.coerce.number().int().min(1).max(MAX_PORT).default(DEFAULT_PORT),
  AGENT_ROUTER_PROVIDERS: providersSchema.optional(),
  SECURE_LOCAL_NET: flagSchema,
  AGENT_ROUTER_ADMIN_TOKEN: z.string().min(1).optional(),
  NODE_ENV: z.string().optional(),
});

/** What the standalone host runs with. */
export interface StandaloneConfig {
  databaseUrl: string;
  port: number;
  /** Where an agent's `<provider>/<model>` goes. None means no agent can run. */
  providers: ProviderConfig[];
  /** Every `/graphql` request that presents no key is the admin. Apps still need a workspace key. */
  secureLocalNet: boolean;
  /** A Bearer token that is the admin on `/graphql`. Never logged. */
  adminToken: string | null;
  /** Whether GraphiQL and introspection are off. */
  isProduction: boolean;
}

/** The environment is wrong: the message says which variable, and how to fix it. */
export class StandaloneConfigError extends Error {
  /**
   * @param message - What is wrong.
   */
  constructor(message: string) {
    super(message);
    this.name = 'StandaloneConfigError';
  }
}

/**
 * Reads the standalone host's config from the environment.
 *
 * @param [env] - The environment.
 * @returns The config.
 * @throws {@link StandaloneConfigError} naming every variable that is wrong.
 */
export function readStandaloneConfig(env: NodeJS.ProcessEnv = process.env): StandaloneConfig {
  // An empty variable is an unset one, as a compose file's `FOO=` leaves it.
  const given = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value !== ''));
  const parsed = envSchema.safeParse(given);
  if (parsed.success === false) {
    throw new StandaloneConfigError(parsed.error.issues.map(({ message }) => message).join('\n'));
  }
  const values = parsed.data;
  return {
    databaseUrl: values.DATABASE_URL,
    port: values.PORT,
    providers: values.AGENT_ROUTER_PROVIDERS ?? [],
    secureLocalNet: values.SECURE_LOCAL_NET,
    adminToken: values.AGENT_ROUTER_ADMIN_TOKEN ?? null,
    isProduction: values.NODE_ENV === 'production',
  };
}
