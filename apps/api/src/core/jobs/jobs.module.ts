import { Inject, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import { loadWorkerConfig } from '../config/config';
import { DATABASE, DatabaseConnection, DatabaseModule } from '../db/database.module';
import type { TenantTransaction } from '../db/transaction-context';
import { logger } from '../logging/logger';
import { runInTenant } from './run-in-tenant';

const workerConfig = loadWorkerConfig();

export class JobsService implements OnModuleInit, OnModuleDestroy {
  private readonly boss = new PgBoss({
    connectionString: workerConfig.WORKER_DATABASE_URL,
    schema: 'pgboss',
    createSchema: false,
    instanceName: 'clinik-worker',
  });

  constructor(@Inject(DATABASE) private readonly database: DatabaseConnection) {
    this.boss.on('error', (error: Error) => logger.error({ err: error }, 'pg-boss error'));
  }

  async onModuleInit(): Promise<void> {
    await this.boss.start();
    logger.info('pg-boss worker process started');
  }

  async onModuleDestroy(): Promise<void> {
    await this.boss.stop();
  }

  runInTenant<T>(
    orgId: string,
    operation: (transaction: TenantTransaction) => Promise<T>,
  ): Promise<T> {
    return runInTenant(this.database.db, orgId, operation);
  }
}

@Module({
  imports: [
    DatabaseModule.forRuntimeRole(
      workerConfig.WORKER_DATABASE_URL,
      'clinic_worker',
      'clinik-worker',
    ),
  ],
  providers: [
    {
      provide: JobsService,
      useFactory: (database: DatabaseConnection) => new JobsService(database),
      inject: [DATABASE],
    },
  ],
  exports: [JobsService],
})
export class JobsModule {}
