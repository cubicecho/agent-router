import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    exclude: ['**/node_modules/**', '**/dist/**', '**/dist-worker/**'],
    // Threads share one process, where a fork per file each loads its own copy of everything.
    pool: 'threads',
    projects: [{ extends: true, test: { name: 'node', environment: 'node', include: ['tests/**/*.test.ts'] } }],
  },
});
