import { DynamicModule, Module } from '@nestjs/common';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';

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
    this.pool = new Pool({
      connectionString,
      max: 10,
      application_name: serviceName,
    });
    this.db = drizzle(this.pool);
  }

  async onModuleInit(): Promise<void> {
    const result = await this.pool.query<{
      current_user: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT current_user,
              roles.rolsuper,
              roles.rolbypassrls
         FROM pg_roles AS roles
        WHERE roles.rolname = current_user`,
    );
    const role = result.rows[0];
    if (!role || role.current_user !== this.expectedRole || role.rolsuper || role.rolbypassrls) {
      throw new Error(
        `Database must connect as non-owner role ${this.expectedRole} without BYPASSRLS.`,
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
