/** What separates a provider's name from its model's id in a model id. A name never holds it. */
export const MODEL_SEPARATOR = '/';

/** A model id taken apart. */
export interface SplitModelId {
  providerName: string;
  /** The model's id at the provider. May itself hold `/`. */
  model: string;
}

/**
 * Takes a model id apart at its first `/`.
 *
 * @param id - A model id.
 * @returns The provider's name and the model's id there, or null for an id with no `/`, which names a pool.
 */
export function splitModelId(id: string): SplitModelId | null {
  const separatorAt = id.indexOf(MODEL_SEPARATOR);
  const model = id.slice(separatorAt + MODEL_SEPARATOR.length);
  const isSplittable = separatorAt > 0 && model !== '';
  return isSplittable ? { providerName: id.slice(0, separatorAt), model } : null;
}
