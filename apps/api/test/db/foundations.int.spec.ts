import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/core/db/migrate';
import { runInTenant } from '../../src/core/jobs/run-in-tenant';
import { withTenantTransaction } from '../../src/core/db/transaction-context';
import { assertExpectedSqlState } from '../../src/core/db/trigger-test-helper';
import {
  type DatabaseHarness,
  migratorPassword,
  migrationsDirectory,
  organizationA,
  organizationB,
  startDatabaseHarness,
  tenantRows,
} from './harness';

let harness: DatabaseHarness;
let appDatabase: ReturnType<typeof drizzle>;
let workerDatabase: ReturnType<typeof drizzle>;

describe('M0 PostgreSQL foundation', () => {
  beforeAll(async () => {
    harness = await startDatabaseHarness();
    appDatabase = drizzle(harness.appPool);
    workerDatabase = drizzle(harness.workerPool);
  }, 120_000);

  afterAll(async () => {
    await harness?.stop();
  });

  it('connects as non-superuser, non-BYPASSRLS runtime roles', async () => {
    const identities = await Promise.all([
      harness.appPool.query(
        'SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
      ),
      harness.workerPool.query(
        'SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
      ),
    ]);
    expect(identities[0].rows[0]).toMatchObject({
      current_user: 'clinic_app',
      rolsuper: false,
      rolbypassrls: false,
    });
    expect(identities[1].rows[0]).toMatchObject({
      current_user: 'clinic_worker',
      rolsuper: false,
      rolbypassrls: false,
    });
    const owner = await harness.adminPool.query(
      `SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'test_tenant_rows'`,
    );
    expect(owner.rows[0]?.tableowner).toBe('clinic_migrator');
  });

  it.each<[string, () => Pool]>([
    ['clinic_app', () => harness.appPool],
    ['clinic_worker', () => harness.workerPool],
  ])('%s sees no tenant rows without transaction context (W1)', async (_role, getPool) => {
    const result = await getPool().query(`SELECT id FROM ${tenantRows}`);
    expect(result.rowCount).toBe(0);
  });

  it('rejects a worker insert without transaction-local tenant context (W2)', async () => {
    try {
      await harness.workerPool.query(
        `INSERT INTO ${tenantRows} (id, organization_id) VALUES (3, $1)`,
        [organizationA],
      );
      throw new Error('Expected RLS to reject an insert without tenant context.');
    } catch (error) {
      assertExpectedSqlState(error, ['42501']);
    }
  });

  it('scopes rows and clears tenant context after commit on a reused connection (W7)', async () => {
    const visibleRows = await withTenantTransaction(
      appDatabase,
      { orgId: organizationA },
      async (tx) => {
        const result = await tx.execute(sql`SELECT id, organization_id FROM test_tenant_rows`);
        return result.rows;
      },
    );
    expect(visibleRows).toHaveLength(1);
    expect(visibleRows[0]?.organization_id).toBe(organizationA);

    const afterCommit = await withTenantTransaction(
      workerDatabase,
      { orgId: organizationA },
      async (tx) => {
        const result = await tx.execute(sql`SELECT public.app_current_org() AS org_id`);
        return result.rows[0]?.org_id;
      },
    );
    expect(afterCommit).toBe(organizationA);

    const nextJobContext = await harness.workerPool.query(
      'SELECT public.app_current_org() AS org_id, current_setting($1, true) AS setting',
      ['app.current_org_id'],
    );
    expect(nextJobContext.rows[0]).toEqual({ org_id: null, setting: '' });
  });

  it('allows runInTenant through clinic_worker and limits it to the supplied organization', async () => {
    const visibleRows = await runInTenant(workerDatabase, organizationB, async (tx) => {
      const result = await tx.execute(sql`SELECT id, organization_id FROM test_tenant_rows`);
      return result.rows;
    });
    expect(visibleRows).toHaveLength(1);
    expect(visibleRows[0]?.organization_id).toBe(organizationB);
  });

  it('attaches the shared updated-at trigger to tables that have the column (T1)', async () => {
    const before = await harness.adminPool.query(
      `SELECT updated_at FROM ${tenantRows} WHERE organization_id = $1`,
      [organizationA],
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    await withTenantTransaction(appDatabase, { orgId: organizationA }, async (tx) => {
      await tx.execute(
        sql`UPDATE test_tenant_rows SET id = id WHERE organization_id = ${organizationA}`,
      );
    });
    const after = await harness.adminPool.query(
      `SELECT updated_at FROM ${tenantRows} WHERE organization_id = $1`,
      [organizationA],
    );
    expect(after.rows[0]?.updated_at.getTime()).toBeGreaterThan(
      before.rows[0]?.updated_at.getTime(),
    );
  });

  it('applies, rolls back and reapplies migrations on a clean database', async () => {
    const scratchDatabase = 'clinik_migration_roundtrip';
    await harness.adminPool.query(`CREATE DATABASE ${scratchDatabase} OWNER clinic_migrator`);
    const host = harness.container.getHost();
    const port = harness.container.getMappedPort(5432);
    const scratchUrl = `postgresql://clinic_migrator:${migratorPassword}@${host}:${port}/${scratchDatabase}`;

    try {
      await runMigrations(scratchUrl, 'up', migrationsDirectory);
      await runMigrations(scratchUrl, 'down', migrationsDirectory);
      await runMigrations(scratchUrl, 'up', migrationsDirectory);

      const pool = new Pool({ connectionString: scratchUrl, max: 1 });
      try {
        const helpers = await pool.query<{ count: number }>(
          `SELECT count(*)::int AS count
             FROM pg_proc
            WHERE proname IN ('attach_tenant_rls', 'attach_set_updated_at')`,
        );
        expect(helpers.rows[0]?.count).toBe(2);
      } finally {
        await pool.end();
      }
    } finally {
      await harness.adminPool.query(`DROP DATABASE IF EXISTS ${scratchDatabase} WITH (FORCE)`);
    }
  });
});
