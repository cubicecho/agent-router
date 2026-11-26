import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    exclude: ['**/node_modules/**', '**/dist/**', '**/dist-worker/**'],
    // Threads share one process, where a fork per file each loads its own copy of everything.
    pool: 'threads',
    // A file's first test starts the stdio fixture, which takes seconds from a checkout on a network share while the
    // other files do the same.
    testTimeout: 20_000,
    hookTimeout: 30_000,
    projects: [{ extends: true, test: { name: 'node', environment: 'node', include: ['tests/**/*.test.ts'] } }],
  },
});
