import { sql } from 'drizzle-orm';
import type { DrizzleDatabase } from './database.module';

export interface TenantContext {
  orgId: string;
  userId?: string;
}

export type TenantTransaction = Parameters<Parameters<DrizzleDatabase['transaction']>[0]>[0];

/**
 * Matches the hyphenated format PostgreSQL accepts for `uuid` input. This is
 * deliberately format-only: version and variant bits are not meaningful for
 * tenant ids, and the goal is to fail before a malformed id reaches
 * `set_config`/`::uuid`.
 */
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidTenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTenantContextError';
  }
}

function assertUuid(value: string | undefined, field: string): void {
  if (value === undefined || value === '') {
    return;
  }
  if (!uuidPattern.test(value)) {
    throw new InvalidTenantContextError(
      `Tenant context ${field} must be a valid UUID, received ${JSON.stringify(value)}.`,
    );
  }
}

export async function withTenantTransaction<T>(
  database: DrizzleDatabase,
  context: TenantContext,
  operation: (transaction: TenantTransaction) => Promise<T>,
): Promise<T> {
  assertUuid(context.orgId, 'organization id');
  assertUuid(context.userId, 'user id');

  return database.transaction(async (transaction) => {
    await transaction.execute(sql`select set_config('app.current_org_id', ${context.orgId}, true)`);
    await transaction.execute(
      sql`select set_config('app.current_user_id', ${context.userId ?? ''}, true)`,
    );
    return operation(transaction);
  });
}
