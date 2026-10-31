import { defineConfig } from 'drizzle-kit';

// Migrations need a single direct connection; runtime traffic uses the pooler.
export default defineConfig({
  dialect: 'postgresql',
  schema: 'src/db/schema.ts',
  out: 'drizzle',
  dbCredentials: {
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? 'postgresql://localhost:5432/vocab',
  },
});
