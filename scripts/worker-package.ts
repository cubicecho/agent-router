import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { build } from 'rolldown';

const run = promisify(execFile);

/** The command's mode: anyone may run it, as a `bin` must be. */
const EXECUTABLE_MODE = 0o755;
/** The repo's root. */
const ROOT = path.resolve(import.meta.dirname, '..');
/** The tsconfig that writes the library's declarations. */
const TYPES_CONFIG = path.join(ROOT, 'tsconfig.worker-types.json');
/** The line that lets the command run as a `bin`. */
const SHEBANG = '#!/usr/bin/env node';

/** The worker package: what it is called, what it holds, what it installs, and the oldest Node it runs on. */
export const WORKER_PACKAGE = Object.freeze({
  name: '@cubicecho/agent-router-worker',
  /** The command its `bin` puts on the PATH. */
  command: 'agent-router-worker',
  /** The command's bundle, at the package's root, from `worker/index.ts`. */
  bin: 'worker.js',
  /** The library's bundle, the package's `.` export, from `worker/lib.ts`. */
  library: 'lib.js',
  /** What both bundles share. */
  chunks: 'chunks',
  /** The library's declarations, at the paths of the sources they describe. */
  types: 'types',
  /** The declaration the `.` export's `types` names. */
  libraryTypes: 'types/worker/lib.d.ts',
  /** agent-core's own floor. */
  node: '22',
  /**
   * The packages the bundles leave as imports, installed beside them in the ranges this repo's `package.json` gives.
   * Everything else the worker loads is bundled in, or left out as unused.
   */
  dependencies: ['@modelcontextprotocol/sdk', 'eventsource-parser', 'zod'],
  /**
   * Left as imports too, but installed by the program that installs the package: its loop and its types are
   * agent-core's, so it must use the same copy.
   */
  peerDependencies: ['@cubicecho/agent-core'],
});

/**
 * Every package the bundles leave as imports. `tests/worker/package.test.ts` checks it against them.
 *
 * @returns The dependencies and the peer dependencies.
 */
export function externalPackages(): string[] {
  return [...WORKER_PACKAGE.dependencies, ...WORKER_PACKAGE.peerDependencies];
}

/** Where `npm run build:worker` writes the package: its folder is what `npm pack` packs. */
export const WORKER_PACKAGE_DIR = path.join(ROOT, 'dist-worker');

/** What building the package needs. */
export interface WorkerPackageOptions {
  /** The folder to write it to. Emptied first. */
  outDir: string;
  /** Its version. */
  version: string;
}

/** The bundles a build wrote. */
export interface WorkerPackageFiles {
  /** The command. */
  bin: string;
  /** The library. */
  library: string;
}

/**
 * Names the package a bare specifier is from.
 *
 * @param specifier - Such as `@modelcontextprotocol/sdk/types.js` or `zod`.
 * @returns Such as `@modelcontextprotocol/sdk` or `zod`.
 */
export function packageOf(specifier: string): string {
  const parts = specifier.split('/');
  return (specifier.startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1)).join('/');
}

/**
 * Whether the bundles leave an import as it is: Node's own modules and the package's dependencies.
 *
 * @param specifier - What a file imports.
 * @returns true to leave it out of the bundles.
 */
function isExternal(specifier: string): boolean {
  if (specifier.startsWith('node:') || builtinModules.includes(specifier)) {
    return true;
  }
  return externalPackages().includes(packageOf(specifier));
}

/**
 * Takes the ranges this repo's `package.json` gives some of its dependencies.
 *
 * @param names - The dependencies.
 * @returns Each one's range, by name.
 */
async function repoRanges(names: readonly string[]): Promise<Record<string, string>> {
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  return Object.fromEntries(
    names.map((name) => {
      const range = manifest.dependencies[name];
      if (range === undefined) {
        throw new Error(`${name} is not one of this repo's dependencies, so the worker package has no range for it.`);
      }
      return [name, range];
    }),
  );
}

/**
 * Builds the worker package: the command and the library bundled for Node 22, the library's declarations, its
 * manifest, and its README and licence.
 *
 * @param options - Where to write it, and its version.
 * @returns The bundles' paths.
 */
export async function buildWorkerPackage({ outDir, version }: WorkerPackageOptions): Promise<WorkerPackageFiles> {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await build({
    input: {
      [path.parse(WORKER_PACKAGE.bin).name]: path.join(ROOT, 'worker/index.ts'),
      [path.parse(WORKER_PACKAGE.library).name]: path.join(ROOT, 'worker/lib.ts'),
    },
    platform: 'node',
    external: isExternal,
    transform: {
      target: `node${WORKER_PACKAGE.node}`,
      define: { AGENT_ROUTER_WORKER_VERSION: JSON.stringify(version) },
    },
    output: {
      dir: outDir,
      format: 'esm',
      entryFileNames: '[name].js',
      chunkFileNames: `${WORKER_PACKAGE.chunks}/[name]-[hash].js`,
      banner: (chunk) => (chunk.isEntry && `${chunk.name}.js` === WORKER_PACKAGE.bin ? SHEBANG : ''),
    },
    logLevel: 'warn',
  });
  const bin = path.join(outDir, WORKER_PACKAGE.bin);
  await chmod(bin, EXECUTABLE_MODE);
  await run(path.join(ROOT, 'node_modules/.bin/tsc'), [
    '-p',
    TYPES_CONFIG,
    '--outDir',
    path.join(outDir, WORKER_PACKAGE.types),
  ]);

  const manifest = {
    name: WORKER_PACKAGE.name,
    version,
    description: "agent-router's worker program: runs a workspace's agent loops on another machine.",
    license: 'MIT',
    type: 'module',
    bin: { [WORKER_PACKAGE.command]: WORKER_PACKAGE.bin },
    exports: {
      '.': { types: `./${WORKER_PACKAGE.libraryTypes}`, import: `./${WORKER_PACKAGE.library}` },
      './package.json': './package.json',
    },
    files: [
      WORKER_PACKAGE.bin,
      WORKER_PACKAGE.library,
      WORKER_PACKAGE.chunks,
      WORKER_PACKAGE.types,
      'README.md',
      'LICENSE',
    ],
    engines: { node: `>=${WORKER_PACKAGE.node}` },
    repository: { type: 'git', url: 'git+https://github.com/cubicecho/agent-router.git' },
    publishConfig: { access: 'public' },
    dependencies: await repoRanges(WORKER_PACKAGE.dependencies),
    peerDependencies: await repoRanges(WORKER_PACKAGE.peerDependencies),
  };
  await writeFile(path.join(outDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await copyFile(path.join(ROOT, 'LICENSE'), path.join(outDir, 'LICENSE'));
  await writeFile(
    path.join(outDir, 'README.md'),
    [
      `# ${WORKER_PACKAGE.name}`,
      '',
      "agent-router's worker program. It dials a router with a worker key and runs the agent loops of the workspaces",
      'that name it, with its own MCP servers as their tools. See "Tools come from workers" in',
      "[agent-router's README](https://github.com/cubicecho/agent-router#tools-come-from-workers).",
      '',
      '## The command',
      '',
      '```bash',
      `npm install -g ${WORKER_PACKAGE.name}`,
      `AGENT_ROUTER_URL=http://agent-router.lan:3100 AGENT_ROUTER_WORKER_KEY=aiw_... ${WORKER_PACKAGE.command}`,
      '```',
      '',
      '`WORKER_CONFIG` names a JSON file of its local servers (`{"servers":{"name":{"command":…}}}`), and',
      '`WORKER_ROOT` the folder its work directories go in.',
      '',
      '## The library',
      '',
      "A program that runs a worker with its own loop in place of agent-core's:",
      '',
      '```ts',
      `import { readWorkerConfig, startWorker } from '${WORKER_PACKAGE.name}';`,
      '```',
      '',
      '`startWorker` takes the loop each assignment runs on. `executeRun`, `RunAssignment` and `RunPorts` are there',
      'so such a loop can be tested on a run as the worker hands it one. `@cubicecho/agent-core` is a peer dependency:',
      "the loop and its types are agent-core's.",
      '',
      `Node ${WORKER_PACKAGE.node} or later.`,
      '',
    ].join('\n'),
  );
  return { bin, library: path.join(outDir, WORKER_PACKAGE.library) };
}

/**
 * Reads the repo's version, which the package takes unless `WORKER_VERSION` names another.
 *
 * @returns The version.
 */
export async function repoVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')) as { version: string };
  return manifest.version;
}
