import { createRequire } from 'node:module';
import path from 'node:path';

// What this package reads of where it is. The environment is the host's: nothing here reads it.

/** What `version()` answers when the package's package.json cannot be read. */
const UNKNOWN_VERSION = 'unknown';

/** The package's root, where package.json and drizzle/ sit. */
export const ROOT = path.resolve(import.meta.dirname, '..', '..');

/**
 * The release of this package that is running, from its package.json.
 *
 * @returns The version, or the unknown-version placeholder when the manifest cannot be read.
 *
 * @remarks
 * Read from the file, not `npm_package_version`: a host starts its server with `node`, so npm never sets it.
 */
export function version(): string {
  try {
    const manifest: unknown = createRequire(import.meta.url)(path.join(ROOT, 'package.json'));
    const isNamed = typeof manifest === 'object' && manifest !== null && 'version' in manifest;
    return isNamed && typeof manifest.version === 'string' ? manifest.version : UNKNOWN_VERSION;
  } catch {
    return UNKNOWN_VERSION;
  }
}
