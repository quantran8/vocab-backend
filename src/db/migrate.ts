import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

// Same journal and __drizzle_migrations table as `drizzle-kit migrate`, without shipping drizzle-kit in the image.
async function main() {
  const pool = new Pool({ connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle' });
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
