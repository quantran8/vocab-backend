import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

export const DB = Symbol('DB');
export const PG_POOL = Symbol('PG_POOL');

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Anything that can run a query: the pool-backed client or an open transaction. */
export type Executor = Db | Tx;

/** Counts statements issued through Drizzle; tests use it to assert query counts do not grow with data. */
export class QueryStats {
  count = 0;
}

/** Raw `sql` results return timestamptz as text, unlike the query builder. */
export const toDate = (value: string | Date): Date => (value instanceof Date ? value : new Date(value));
