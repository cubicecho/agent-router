import { createHash, randomBytes } from 'node:crypto';
import { KEY_DEFAULTS } from '../core/defaults.ts';

/** What every workspace key starts with, so a leaked one is recognisable as the router's. */
export const KEY_PREFIX = 'air_';
/** What every worker key starts with, so no door for apps or people mistakes one for theirs. */
export const WORKER_KEY_PREFIX = 'aiw_';

/** A key as it is made: the secret, which is shown once, and what is stored about it. */
export interface MintedKey {
  /** The whole key, for the app. Never stored or logged. */
  secret: string;
  /** What the table keeps to find it again. */
  hash: string;
  /** The prefix and first characters, kept in the clear. */
  start: string;
}

/**
 * Hashes a key the way the table stores it.
 *
 * @param secret - The whole key.
 * @returns Its SHA-256, in hex.
 */
export function hashKey(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/**
 * Makes a new key.
 *
 * @param [prefix] - What it starts with: {@link KEY_PREFIX} for a workspace key, {@link WORKER_KEY_PREFIX} for a
 *   worker's.
 * @returns The secret and what is stored about it.
 */
export function mintKey(prefix: string = KEY_PREFIX): MintedKey {
  const secret = `${prefix}${randomBytes(KEY_DEFAULTS.secretBytes).toString('base64url')}`;
  return { secret, hash: hashKey(secret), start: secret.slice(0, prefix.length + KEY_DEFAULTS.visibleChars) };
}

/**
 * Whether a secret is shaped as a worker key. Only the worker doors take one.
 *
 * @param secret - The key as a request sent it.
 * @returns true when it starts with {@link WORKER_KEY_PREFIX}.
 */
export function isWorkerKey(secret: string): boolean {
  return secret.startsWith(WORKER_KEY_PREFIX);
}
