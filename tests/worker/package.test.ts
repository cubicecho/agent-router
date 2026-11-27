import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildWorkerPackage,
  externalPackages,
  packageOf,
  WORKER_PACKAGE,
  type WorkerPackageFiles,
} from '../../scripts/worker-package.ts';
import * as library from '../../worker/lib.ts';

const run = promisify(execFile);

/** The repo's root. */
const ROOT = path.resolve(import.meta.dirname, '../..');
/** Where the command and the library start. */
const ENTRIES = [path.join(ROOT, 'worker/index.ts'), path.join(ROOT, 'worker/lib.ts')];
/** The server folders the worker must never load: the database and the snapshot built from it. */
const FORBIDDEN = ['server/db/'];
/** The version the test builds the package at. */
const VERSION = '9.8.7-test';
/** How long building, starting and removing the bundle may take: a checkout on a network share is slow. */
const SLOW_MS = 180_000;
/**
 * Every module a file loads when it runs: `import … from`, `export … from` and `import('…')`, but not
 * `import type` or `export type`, which Node's type stripping erases.
 */
const RUNTIME_SPECIFIER =
  /^\s*(?:import|export)\s+(?!type\s)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm;
/** An import the bundles leave for Node to resolve, or one bundle's import of a shared chunk. */
const BUNDLE_IMPORT = /^(?:import|export)\s[^;]*?from\s*"([^"]+)"|^import\s*"([^"]+)"/gm;

/**
 * Follows the worker's runtime imports from the command's and the library's entry points.
 *
 * @returns Every file it loads, relative to the root.
 */
function workerFiles(): string[] {
  const files = new Set<string>();
  const visit = (file: string): void => {
    if (files.has(file)) {
      return;
    }
    files.add(file);
    for (const [, from, dynamic] of readFileSync(file, 'utf8').matchAll(RUNTIME_SPECIFIER)) {
      const specifier = from ?? dynamic ?? '';
      if (specifier.startsWith('.')) {
        visit(path.resolve(path.dirname(file), specifier));
      }
    }
  };
  for (const entry of ENTRIES) {
    visit(entry);
  }
  return [...files].map((file) => path.relative(ROOT, file)).sort();
}

describe('the worker package', () => {
  let outDir = '';
  let files: WorkerPackageFiles = { bin: '', library: '' };

  /**
   * Reads every bundle the build wrote: the two entries and their shared chunks.
   *
   * @returns Their text, joined.
   */
  const bundled = async (): Promise<string> => {
    const chunks = await readdir(path.join(outDir, WORKER_PACKAGE.chunks));
    const paths = [files.bin, files.library, ...chunks.map((name) => path.join(outDir, WORKER_PACKAGE.chunks, name))];
    return (await Promise.all(paths.map((file) => readFile(file, 'utf8')))).join('\n');
  };

  beforeAll(async () => {
    outDir = await mkdtemp(path.join(tmpdir(), 'worker-package-'));
    files = await buildWorkerPackage({ outDir, version: VERSION });
    // The repo's node_modules beside it, so its imports resolve as an installed package's would.
    await symlink(path.join(ROOT, 'node_modules'), path.join(outDir, 'node_modules'));
  }, SLOW_MS);

  afterAll(async () => {
    await rm(outDir, { recursive: true, force: true });
  }, SLOW_MS);

  it('never loads the database or the snapshot', () => {
    expect(workerFiles().filter((file) => FORBIDDEN.some((folder) => file.startsWith(folder)))).toEqual([]);
  });

  it('leaves out only Node and its dependencies, and uses every one', async () => {
    const imported = new Set(
      [...(await bundled()).matchAll(BUNDLE_IMPORT)]
        .map(([, from, bare]) => from ?? bare ?? '')
        .filter((specifier) => specifier.startsWith('.') === false)
        .filter((specifier) => specifier.startsWith('node:') === false && builtinModules.includes(specifier) === false)
        .map(packageOf),
    );
    expect([...imported].sort()).toEqual(externalPackages().sort());
  });

  it('exports, as a library, what worker/lib.ts exports', async () => {
    const published = await import(pathToFileURL(files.library).href);
    expect(Object.keys(published).sort()).toEqual(Object.keys(library).sort());
  });

  it('declares the library without the database', async () => {
    const declared = await readFile(path.join(outDir, WORKER_PACKAGE.libraryTypes), 'utf8');
    expect(declared).toContain('startWorker');
    const types = await readdir(path.join(outDir, WORKER_PACKAGE.types), { recursive: true });
    expect(types.filter((file) => FORBIDDEN.some((folder) => file.startsWith(folder)))).toEqual([]);
  });

  it("takes each dependency's range from the repo's own, with agent-core as a peer", async () => {
    const repo = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const manifest = JSON.parse(await readFile(path.join(outDir, 'package.json'), 'utf8')) as {
      version: string;
      bin: Record<string, string>;
      engines: { node: string };
      dependencies: Record<string, string>;
      peerDependencies: Record<string, string>;
    };
    expect(manifest).toMatchObject({
      version: VERSION,
      bin: { [WORKER_PACKAGE.command]: WORKER_PACKAGE.bin },
      exports: { '.': { types: `./${WORKER_PACKAGE.libraryTypes}`, import: `./${WORKER_PACKAGE.library}` } },
      engines: { node: `>=${WORKER_PACKAGE.node}` },
    });
    expect(manifest.dependencies).toEqual(
      Object.fromEntries(WORKER_PACKAGE.dependencies.map((name) => [name, repo.dependencies[name]])),
    );
    expect(manifest.peerDependencies).toEqual(
      Object.fromEntries(WORKER_PACKAGE.peerDependencies.map((name) => [name, repo.dependencies[name]])),
    );
  });

  it(
    'carries its version written in, and starts far enough to refuse a missing router address',
    async () => {
      expect((await readFile(files.bin, 'utf8')).startsWith('#!/usr/bin/env node\n')).toBe(true);
      expect((await readFile(files.library, 'utf8')).startsWith('#!')).toBe(false);
      const text = await bundled();
      expect(text).toContain(JSON.stringify(VERSION));
      expect(text).not.toContain('AGENT_ROUTER_WORKER_VERSION');

      const started = run(process.execPath, [files.bin], { env: { PATH: process.env.PATH ?? '' } });
      await expect(started).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('AGENT_ROUTER_URL') });
    },
    SLOW_MS,
  );
});
