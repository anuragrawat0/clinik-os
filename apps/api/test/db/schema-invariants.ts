import type { Pool } from 'pg';

/**
 * Tables from DATABASE_DESIGN §11.2 that are deliberately outside tenant RLS.
 * They hold no tenant column, or are system-only and confined to a module that
 * never runs as the tenant-scoped app role. `stripe_webhook_events` is the only
 * one of these that carries `organization_id`, so it must stay visible here.
 */
export const nonTenantTables: readonly string[] = [
  'users',
  'sessions',
  'auth_tokens',
  'organizations',
  'stripe_webhook_events',
];

export type TenantRlsViolationReason = 'rls_disabled' | 'force_rls_disabled' | 'missing_policy';

export interface TenantRlsViolation {
  schema: string;
  table: string;
  reason: TenantRlsViolationReason;
}

export async function findTenantRlsViolations(
  pool: Pool,
  schema = 'public',
): Promise<TenantRlsViolation[]> {
  const result = await pool.query<{
    schema: string;
    table: string;
    relrowsecurity: boolean;
    relforcerowsecurity: boolean;
    policy_count: number;
  }>(
    `SELECT namespace.nspname AS schema,
            relation.relname AS table,
            relation.relrowsecurity,
            relation.relforcerowsecurity,
            (SELECT count(*)::int FROM pg_policy policy WHERE policy.polrelid = relation.oid) AS policy_count
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1
        AND relation.relkind IN ('r', 'p')
        AND EXISTS (
          SELECT 1
            FROM pg_attribute attribute
           WHERE attribute.attrelid = relation.oid
             AND attribute.attname = 'organization_id'
             AND attribute.attnum > 0
             AND NOT attribute.attisdropped
        )
      ORDER BY relation.relname`,
    [schema],
  );

  const excluded = new Set(nonTenantTables);
  const violations: TenantRlsViolation[] = [];
  for (const row of result.rows) {
    if (excluded.has(row.table)) continue;
    if (!row.relrowsecurity) {
      violations.push({ schema: row.schema, table: row.table, reason: 'rls_disabled' });
    } else if (!row.relforcerowsecurity) {
      violations.push({ schema: row.schema, table: row.table, reason: 'force_rls_disabled' });
    } else if (row.policy_count === 0) {
      violations.push({ schema: row.schema, table: row.table, reason: 'missing_policy' });
    }
  }
  return violations;
}

export interface UpdatedAtTriggerViolation {
  schema: string;
  table: string;
}

/**
 * Every table with an `updated_at` column must carry the `set_updated_at`
 * trigger attached by `attach_set_updated_at` (T1).
 */
export async function findMissingUpdatedAtTriggers(
  pool: Pool,
  schema = 'public',
): Promise<UpdatedAtTriggerViolation[]> {
  const result = await pool.query<{ schema: string; table: string }>(
    `SELECT namespace.nspname AS schema, relation.relname AS table
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1
        AND relation.relkind IN ('r', 'p')
        AND EXISTS (
          SELECT 1
            FROM pg_attribute attribute
           WHERE attribute.attrelid = relation.oid
             AND attribute.attname = 'updated_at'
             AND attribute.attnum > 0
             AND NOT attribute.attisdropped
        )
        AND NOT EXISTS (
          SELECT 1
            FROM pg_trigger trigger
           WHERE trigger.tgrelid = relation.oid
             AND NOT trigger.tgisinternal
             AND trigger.tgname = relation.relname || '_set_updated_at'
        )
      ORDER BY relation.relname`,
    [schema],
  );
  return result.rows;
}
