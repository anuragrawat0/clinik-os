import { sql } from 'drizzle-orm';
import type { DrizzleDatabase } from './database.module';

export interface TenantContext {
  orgId: string;
  userId?: string;
}

export type TenantTransaction = Parameters<Parameters<DrizzleDatabase['transaction']>[0]>[0];

export async function withTenantTransaction<T>(
  database: DrizzleDatabase,
  context: TenantContext,
  operation: (transaction: TenantTransaction) => Promise<T>,
): Promise<T> {
  return database.transaction(async (transaction) => {
    await transaction.execute(sql`select set_config('app.current_org_id', ${context.orgId}, true)`);
    await transaction.execute(
      sql`select set_config('app.current_user_id', ${context.userId ?? ''}, true)`,
    );
    return operation(transaction);
  });
}
