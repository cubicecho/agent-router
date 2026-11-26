import { AGENT_SPEC } from '@cubicecho/agent-core/spec';
import { describe, expect, it } from 'vitest';
import { agentContextLength } from '../../server/agents/context-length.ts';
import { EMPTY_SNAPSHOT, type Snapshot, type SnapshotProvider } from '../../server/db/snapshot.ts';
import type { ModelsPort } from '../../server/ports.ts';

/**
 * Builds a provider for the snapshot.
 *
 * @param name - Its name.
 * @param [enabled] - Whether it is on.
 * @returns The provider.
 */
function provider(name: string, enabled = true): SnapshotProvider {
  return { name, enabled };
}

/** What the host's models area says each provider's `qwen3:32b` reads, by provider; null states none. */
const WINDOWS: Record<string, number | null> = { vllm: 32_768, openrouter: 131_072, ollama: null, off: 1_024 };

/** The host's models, as far as context lengths go. */
const MODELS: Pick<ModelsPort, 'contextLengthOf'> = {
  contextLengthOf: async (providerName, model) => (model === 'qwen3:32b' ? (WINDOWS[providerName] ?? null) : null),
};

const SNAPSHOT: Snapshot = {
  ...EMPTY_SNAPSHOT,
  providers: new Map(
    [provider('vllm'), provider('openrouter'), provider('ollama'), provider('off', false)].map((p) => [p.name, p]),
  ),
  pools: new Map([
    [
      'big',
      {
        name: 'big',
        enabled: true,
        targets: ['vllm', 'openrouter', 'ollama', 'off'].map((name) => ({ providerName: name, model: 'qwen3:32b' })),
      },
    ],
  ]),
};

/**
 * Works out an agent's context length against the snapshot above.
 *
 * @param model - The document's `model`.
 * @param [extra] - More of the document.
 * @returns The context length, or null.
 */
function lengthFor(model: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<number | null> {
  const document = { spec: AGENT_SPEC, id: 'helper', model, tools: { servers: [] }, ...extra };
  return agentContextLength('helper', document, SNAPSHOT, MODELS);
}

describe("an agent's context length", () => {
  it("is the document's when it states one above zero", async () => {
    expect(await lengthFor({ model: 'vllm/qwen3:32b', contextLength: 8_192 })).toBe(8_192);
    expect(await lengthFor({ model: 'vllm/qwen3:32b', contextLength: 0 })).toBe(32_768);
  });

  it("is otherwise what the host says the model's provider lists", async () => {
    expect(await lengthFor({ model: 'vllm/qwen3:32b' })).toBe(32_768);
    expect(await lengthFor({ model: 'openrouter/qwen3:32b' })).toBe(131_072);
  });

  it("is a pool's smallest known one, leaving out targets that state none and providers that are off", async () => {
    expect(await lengthFor({ model: 'big' })).toBe(32_768);
  });

  it('is unknown when nothing states it, the provider is off, or the agent calls its own endpoint', async () => {
    expect(await lengthFor({ model: 'ollama/qwen3:32b' })).toBeNull();
    expect(await lengthFor({ model: 'off/qwen3:32b' })).toBeNull();
    expect(await lengthFor({ model: 'vllm/other' })).toBeNull();
    expect(await lengthFor({ model: 'no-such-pool' })).toBeNull();
    expect(await lengthFor({ model: 'vllm/qwen3:32b' }, { endpoint: { baseUrl: 'http://vllm/v1' } })).toBeNull();
  });
});
