import { defineConfig } from 'drizzle-kit';

// This package's migrations, generated from its own tables alone, so no database is needed to write one. A host
// applies them with `AGENT_ROUTER_MIGRATIONS` (`server/db/client.ts`), beside its own.
export default defineConfig({
  out: './drizzle',
  schema: './server/db/schema.ts',
  dialect: 'postgresql',
});
