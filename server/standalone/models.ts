import { errorMessage } from '../core/errors.ts';
import { isRecord } from '../core/is-record.ts';
import { MODELS_BASE_URL, MS_PER_MINUTE } from '../core/wire.ts';
import { splitModelId } from '../models/naming.ts';
import { ModelFailure, openAiErrorBody } from '../models/openai-error.ts';
import type { HostProvider, ModelsPort } from '../ports.ts';
import type { ProviderConfig } from './config.ts';

// The standalone host's models: each run's model call goes to the provider its model id names, under the model's own
// id there, with that provider's key. No pools, no balancing, no usage records: that is ai-router's models area.

/** How long a provider's model listing is kept for context lengths. */
const LISTING_TTL_MS = MS_PER_MINUTE;
/** The request headers passed on to a provider. The run's own credentials never are. */
const FORWARDED_HEADERS = ['content-type', 'accept'];
/** What a provider's listing may call a model's context window, in the order they are tried. */
const CONTEXT_LENGTH_FIELDS = ['context_length', 'context_window', 'max_model_len', 'max_context_length'];

/** One model as a provider lists it. */
interface ListedModel {
  id: string;
  contextLength: number | null;
}

/** The standalone models area: the port, and the providers the snapshot checks documents against. */
export interface StandaloneModels {
  port: ModelsPort;
  providers: ReadonlyMap<string, HostProvider>;
}

/**
 * Answers in OpenAI's error envelope.
 *
 * @param failure - What went wrong.
 * @param message - What the run is told.
 * @param [param] - The request field it is about.
 * @returns The response.
 */
function failed(failure: ModelFailure, message: string, param: string | null = null): Response {
  return Response.json(openAiErrorBody(failure, message, param), { status: failure.status });
}

/**
 * Reads the context window a listing states for a model.
 *
 * @param entry - One entry of a provider's `/models`.
 * @returns The window, or null when it states none.
 */
function contextLengthIn(entry: Record<string, unknown>): number | null {
  for (const field of CONTEXT_LENGTH_FIELDS) {
    const value = entry[field];
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
      return value;
    }
  }
  return null;
}

/**
 * Builds the standalone host's models over its configured providers.
 *
 * @param providers - The providers, from `AGENT_ROUTER_PROVIDERS`.
 * @param [upstream] - How a provider is reached; tests pass their own.
 * @param [now] - The clock the listing cache is judged by.
 * @returns The models.
 */
export function createStandaloneModels(
  providers: readonly ProviderConfig[],
  upstream: typeof globalThis.fetch = globalThis.fetch,
  now: () => number = Date.now,
): StandaloneModels {
  const byName = new Map(providers.map((provider) => [provider.name, provider] as const));
  const listings = new Map<string, { at: number; models: Promise<ListedModel[]> }>();

  /**
   * Sends a request to a provider, with its key.
   *
   * @param provider - Where it goes.
   * @param path - The path under its base URL, such as `/chat/completions`.
   * @param init - The request.
   * @returns Its answer.
   */
  const send = (provider: ProviderConfig, path: string, init: RequestInit): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (provider.apiKey !== undefined) {
      headers.set('authorization', `Bearer ${provider.apiKey}`);
    }
    return upstream(`${provider.baseUrl.replace(/\/+$/, '')}${path}`, { ...init, headers });
  };

  /**
   * Reads a provider's model listing, kept for a minute.
   *
   * @param provider - The provider.
   * @returns Its models; none when it can't be read.
   */
  const listingOf = (provider: ProviderConfig): Promise<ListedModel[]> => {
    const known = listings.get(provider.name);
    if (known !== undefined && now() - known.at < LISTING_TTL_MS) {
      return known.models;
    }
    const models = (async (): Promise<ListedModel[]> => {
      try {
        const response = await send(provider, '/models', { headers: { accept: 'application/json' } });
        const body: unknown = response.ok ? await response.json() : null;
        const data = isRecord(body) && Array.isArray(body.data) ? body.data : [];
        return data.flatMap((entry): ListedModel[] =>
          isRecord(entry) && typeof entry.id === 'string'
            ? [{ id: entry.id, contextLength: contextLengthIn(entry) }]
            : [],
        );
      } catch (error) {
        console.warn(`[models] could not list ${provider.name}'s models: ${errorMessage(error)}`);
        return [];
      }
    })();
    listings.set(provider.name, { at: now(), models });
    return models;
  };

  /**
   * Answers `GET /models`: every provider's models, as agents name them.
   *
   * @returns OpenAI's model list.
   */
  const listAll = async (): Promise<Response> => {
    const lists = await Promise.all(
      [...byName.values()].map(async (provider) =>
        (await listingOf(provider)).map(({ id }) => ({
          id: `${provider.name}/${id}`,
          object: 'model',
          owned_by: provider.name,
        })),
      ),
    );
    return Response.json({ object: 'list', data: lists.flat() });
  };

  /**
   * Answers one call to the router's models address.
   *
   * @param input - What the run's `fetch` was handed.
   * @param [init] - Its options.
   * @returns The provider's answer, passed through, or OpenAI's error envelope.
   */
  const answer = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    if (request.url.startsWith(MODELS_BASE_URL) === false) {
      return failed(ModelFailure.NotFound, `The router's models do not answer ${request.url}.`);
    }
    const path = request.url.slice(MODELS_BASE_URL.length);
    if (request.method === 'GET' && path === '/models') {
      return listAll();
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return failed(ModelFailure.BadRequest, 'The request body must be JSON.');
    }
    if (isRecord(body) === false || typeof body.model !== 'string') {
      return failed(ModelFailure.BadRequest, 'The request names no model.', 'model');
    }
    const split = splitModelId(body.model);
    const provider = split === null ? undefined : byName.get(split.providerName);
    if (split === null || provider === undefined) {
      const why =
        split === null ? 'This host has no pools; name a model as <provider>/<model>.' : 'No provider is named that.';
      return failed(ModelFailure.ModelNotFound, `No model is named "${body.model}". ${why}`, 'model');
    }
    const headers = new Headers();
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers.get(name);
      if (value !== null) {
        headers.set(name, value);
      }
    }
    try {
      return await send(provider, path, {
        method: request.method,
        headers,
        body: JSON.stringify({ ...body, model: split.model }),
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal.aborted) {
        throw error;
      }
      return failed(ModelFailure.UpstreamFailed, `${provider.name} did not answer: ${errorMessage(error)}`);
    }
  };

  return {
    providers: new Map([...byName.keys()].map((name) => [name, { name, enabled: true }] as const)),
    port: {
      fetchFor: () => answer,
      contextLengthOf: async (providerName, model) => {
        const provider = byName.get(providerName);
        if (provider === undefined) {
          return null;
        }
        const listed = (await listingOf(provider)).find(({ id }) => id === model);
        return listed?.contextLength ?? null;
      },
    },
  };
}
