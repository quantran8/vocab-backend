import { Global, Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { AppConfig } from '../config/app-config';
import { Clock } from '../common/clock';
import { DB, PG_POOL, QueryStats } from './db';
import * as schema from './schema';

const logger = new Logger('DbModule');

class PoolShutdown implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown() {
    await this.pool.end();
  }
}

@Global()
@Module({
  providers: [
    AppConfig,
    Clock,
    QueryStats,
    {
      provide: PG_POOL,
      inject: [AppConfig],
      useFactory: (config: AppConfig) => {
        const pool = new Pool({ connectionString: config.databaseUrl, max: config.dbPoolSize });
        // An unhandled 'error' event kills the process: idle clients report to the pool, checked-out ones only to themselves.
        pool.on('error', (error) => logger.warn(`Idle connection lost: ${error.message}`));
        pool.on('connect', (client) => client.on('error', () => undefined));
        return pool;
      },
    },
    {
      provide: DB,
      inject: [PG_POOL, QueryStats],
      useFactory: (pool: Pool, stats: QueryStats) =>
        drizzle(pool, { schema, logger: { logQuery: () => { stats.count += 1; } } }),
    },
    PoolShutdown,
  ],
  exports: [AppConfig, Clock, QueryStats, DB],
})
export class DbModule {}
