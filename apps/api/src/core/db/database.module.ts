import { DynamicModule, Module } from '@nestjs/common';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { loadDatabaseTimeouts } from '../config/config';
import { logger } from '../logging/logger';
import { errorClass, errorCode, StartupFailure } from '../logging/startup-failure';
import { findRuntimeRoleViolations, readRuntimeRoleState } from './role-self-check';

export const DATABASE = Symbol('DATABASE');

export type DrizzleDatabase = NodePgDatabase;

export class DatabaseConnection {
  readonly pool: Pool;
  readonly db: DrizzleDatabase;

  constructor(
    connectionString: string,
    private readonly expectedRole: 'clinic_app' | 'clinic_worker',
    serviceName: string,
  ) {
    const timeouts = loadDatabaseTimeouts();
    this.pool = new Pool({
      connectionString,
      max: 10,
      application_name: serviceName,
      connectionTimeoutMillis: timeouts.DB_POOL_ACQUIRE_TIMEOUT_MS,
      statement_timeout: timeouts.DB_STATEMENT_TIMEOUT_MS,
      idle_in_transaction_session_timeout: timeouts.DB_IDLE_IN_TX_TIMEOUT_MS,
    });
    const logConnectionError = (error: Error) =>
      logger.error(
        { errorClass: errorClass(error), code: errorCode(error) },
        'Database connection failed',
      );
    this.pool.on('error', logConnectionError);
    // PostgreSQL can terminate a checked-out connection between queries.
    this.pool.on('acquire', (client) => client.on('error', logConnectionError));
    this.pool.on('release', (_error, client) => client.off('error', logConnectionError));
    this.db = drizzle(this.pool);
  }

  async onModuleInit(): Promise<void> {
    const state = await readRuntimeRoleState(this.pool).catch((cause: unknown) => {
      throw new StartupFailure('db.role-self-check.query', cause);
    });
    const violations = findRuntimeRoleViolations(state, this.expectedRole);
    if (violations.length > 0) {
      throw new StartupFailure(
        'db.role-self-check.validate',
        new Error(`Refusing to start with an unsafe database role: ${violations.join('; ')}.`),
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  async check(): Promise<void> {
    await this.db.execute(sql`select 1`);
  }
}

@Module({})
export class DatabaseModule {
  static forRuntimeRole(
    connectionString: string,
    expectedRole: 'clinic_app' | 'clinic_worker',
    serviceName: string,
  ): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [
        {
          provide: DATABASE,
          useFactory: () => new DatabaseConnection(connectionString, expectedRole, serviceName),
        },
      ],
      exports: [DATABASE],
    };
  }
}
