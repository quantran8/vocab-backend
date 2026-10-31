import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { AppConfig } from '../config/app-config';
import { Clock } from '../common/clock';
import { DB, PG_POOL, QueryStats } from './db';
import * as schema from './schema';

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
      useFactory: (config: AppConfig) => new Pool({ connectionString: config.databaseUrl, max: config.dbPoolSize }),
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
