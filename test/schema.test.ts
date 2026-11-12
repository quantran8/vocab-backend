import { readFileSync } from 'node:fs';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { Client } from 'pg';
import * as schema from '../src/db/schema';

const SPEC_SQL = 'spec/001_initial_schema_v0.4_FULL_SPEC_PROPOSED.sql';

const CHECKS_SQL = `
  SELECT conrelid::regclass::text AS tbl, pg_get_constraintdef(oid) AS def
  FROM pg_constraint WHERE contype = 'c' AND connamespace = 'public'::regnamespace
  ORDER BY 1, 2`;
const FKS_SQL = `
  SELECT conrelid::regclass::text AS tbl, pg_get_constraintdef(oid) AS def
  FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace
  ORDER BY 1, 2`;
const UNIQUES_SQL = `
  SELECT i.indrelid::regclass::text AS tbl, i.indisprimary AS is_primary,
         (SELECT array_agg(a.attname ORDER BY k.ord)
          FROM unnest(i.indkey) WITH ORDINALITY k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) AS cols
  FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
  WHERE i.indisunique AND c.relnamespace = 'public'::regnamespace
  ORDER BY 1, 2, 3`;
const INDEXES_SQL = `
  SELECT indexname, indexdef FROM pg_indexes
  WHERE schemaname = 'public' AND indexname LIKE 'idx\\_%' ORDER BY 1`;
const COLUMNS_SQL = `
  SELECT table_name, column_name, data_type, character_maximum_length, numeric_precision,
         numeric_scale, is_nullable,
         CASE WHEN column_default LIKE 'gen_random_uuid%' THEN NULL
              WHEN column_default = 'CURRENT_TIMESTAMP' THEN 'now()'
              ELSE column_default END AS col_default
  FROM information_schema.columns
  WHERE table_schema = 'public'
  ORDER BY 1, 2`;

async function connect(url: string) {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

describe('schema parity with the spec SQL (C62)', () => {
  let migrated: Client;
  let spec: Client;

  beforeAll(async () => {
    migrated = await connect(process.env.TEST_DATABASE_URL!);
    spec = await connect(process.env.TEST_SPEC_DATABASE_URL!);
    await spec.query(readFileSync(SPEC_SQL, 'utf8'));
  });
  afterAll(async () => {
    await migrated.end();
    await spec.end();
  });

  it.each([
    ['CHECK constraints', CHECKS_SQL],
    ['foreign keys', FKS_SQL],
    ['primary and unique keys', UNIQUES_SQL],
    ['named indexes', INDEXES_SQL],
    ['columns', COLUMNS_SQL],
  ])('%s match', async (_, sql) => {
    const [ours, theirs] = await Promise.all([migrated.query(sql), spec.query(sql)]);
    expect(ours.rows).toEqual(theirs.rows);
  });

  it('has no drift between the Drizzle schema and migrations', async () => {
    const tables = Object.values(schema).flatMap((v) => {
      try { return [getTableConfig(v as never)]; } catch { return []; }
    });
    const { rows } = await migrated.query(
      `SELECT table_name, column_name, udt_name, is_nullable
       FROM information_schema.columns WHERE table_schema = 'public'`,
    );
    const catalog = new Map(rows.map((r) => [`${r.table_name}.${r.column_name}`, r]));
    const UDT = { PgUUID: 'uuid', PgText: 'text', PgVarchar: 'varchar', PgChar: 'bpchar', PgInteger: 'int4', PgSmallInt: 'int2', PgBigInt53: 'int8',
      PgBoolean: 'bool', PgJsonb: 'jsonb', PgNumeric: 'numeric', PgNumericNumber: 'numeric', PgTimestamp: 'timestamptz', PgDateString: 'date' } as Record<string, string>;
    const declared = tables.flatMap((t) => t.columns.map((c) => ({
      key: `${t.name}.${c.name}`, udt: UDT[c.columnType], nullable: c.notNull ? 'NO' : 'YES',
    })));

    expect(new Set(declared.map((d) => d.key.split('.')[0]))).toEqual(new Set(rows.map((r) => r.table_name)));
    expect(declared.map((d) => d.key).sort()).toEqual([...catalog.keys()].sort());
    for (const d of declared) {
      expect({ key: d.key, udt: catalog.get(d.key).udt_name, nullable: catalog.get(d.key).is_nullable }).toEqual({ key: d.key, udt: d.udt, nullable: d.nullable });
    }
  });

  it('enables RLS on every table', async () => {
    const { rows } = await migrated.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND NOT rowsecurity`,
    );
    expect(rows).toEqual([]);
  });

  it('keeps no database default on id columns', async () => {
    const { rows } = await migrated.query(
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'id' AND column_default IS NOT NULL`,
    );
    expect(rows).toEqual([]);
  });
});
