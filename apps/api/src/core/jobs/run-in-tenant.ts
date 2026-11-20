import type { DrizzleDatabase } from '../db/database.module';
import { withTenantTransaction, type TenantTransaction } from '../db/transaction-context';

export function runInTenant<T>(
  database: DrizzleDatabase,
  orgId: string,
  operation: (transaction: TenantTransaction) => Promise<T>,
): Promise<T> {
  return withTenantTransaction(database, { orgId }, operation);
}
