import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import EmbeddedPostgres from 'embedded-postgres';
import { Pool } from 'pg';

const PORT = 54_329;
const USER = 'postgres';
const PASSWORD = 'postgres';
const BASE_URL = `postgresql://${USER}:${PASSWORD}@localhost:${PORT}`;

export default async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'vocab-pg-'));
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: USER,
    password: PASSWORD,
    port: PORT,
    persistent: false,
    onLog: () => undefined,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('vocab_test');
  await pg.createDatabase('vocab_spec');
  const admin = pg.getPgClient();
  await admin.connect();
  await admin.query(`ALTER DATABASE vocab_test SET timezone = 'UTC'`);
  await admin.end();

  const databaseUrl = `${BASE_URL}/vocab_test`;
  const pool = new Pool({ connectionString: databaseUrl });
  await migrate(drizzle(pool), { migrationsFolder: 'drizzle' });
  await pool.end();
  process.env.TEST_DATABASE_URL = databaseUrl;
  process.env.TEST_SPEC_DATABASE_URL = `${BASE_URL}/vocab_spec`;

  return async () => {
    await pg.stop();
    rmSync(dir, { recursive: true, force: true });
  };
}
