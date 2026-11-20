import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenantTransaction } from '../../src/core/db/transaction-context';
import { findRuntimeRoleViolations, readRuntimeRoleState } from '../../src/core/db/role-self-check';
import { assertExpectedSqlState } from '../../src/core/db/trigger-test-helper';
import {
  type DatabaseHarness,
  databaseName,
  organizationA,
  organizationB,
  startDatabaseHarness,
  tenantRows,
} from './harness';

const runtimeRoles = ['clinic_migrator', 'clinic_app', 'clinic_worker'];

let harness: DatabaseHarness;
let appDatabase: ReturnType<typeof drizzle>;
let workerDatabase: ReturnType<typeof drizzle>;

async function expectSqlState(operation: Promise<unknown>, acceptedCodes: string[]): Promise<void> {
  try {
    await operation;
  } catch (error) {
    assertExpectedSqlState(error, acceptedCodes);
    return;
  }
  throw new Error(`Expected SQLSTATE ${acceptedCodes.join(' or ')} but the statement succeeded.`);
}

function roleConnection(role: string, password: string): string {
  const host = harness.container.getHost();
  const port = harness.container.getMappedPort(5432);
  return `postgresql://${role}:${password}@${host}:${port}/${databaseName}`;
}

describe('database role isolation and bootstrap', () => {
  beforeAll(async () => {
    harness = await startDatabaseHarness();
    appDatabase = drizzle(harness.appPool);
    workerDatabase = drizzle(harness.workerPool);
  }, 120_000);

  afterAll(async () => {
    await harness?.stop();
  });

  beforeEach(async () => {
    await harness.resetTenantRows();
  });

  it('creates the three runtime roles with least privilege from the real bootstrap script', async () => {
    const roles = await harness.adminPool.query<{
      rolname: string;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolinherit: boolean;
      rolbypassrls: boolean;
      rolcanlogin: boolean;
    }>(
      `SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolbypassrls, rolcanlogin
         FROM pg_roles
        WHERE rolname = ANY($1)
        ORDER BY rolname`,
      [runtimeRoles],
    );

    expect(roles.rows).toHaveLength(3);
    for (const role of roles.rows) {
      expect(role).toMatchObject({
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolbypassrls: false,
        rolcanlogin: true,
      });
    }
  });

  it('makes clinic_migrator the database and schema owner and clinic_worker the pgboss owner', async () => {
    const ownership = await harness.adminPool.query<{
      database_owner: string;
      public_owner: string;
      pgboss_owner: string;
    }>(
      `SELECT pg_get_userbyid(database.datdba) AS database_owner,
              pg_get_userbyid(public_namespace.nspowner) AS public_owner,
              pg_get_userbyid(pgboss_namespace.nspowner) AS pgboss_owner
         FROM pg_database AS database
         CROSS JOIN pg_namespace AS public_namespace
         CROSS JOIN pg_namespace AS pgboss_namespace
        WHERE database.datname = current_database()
          AND public_namespace.nspname = 'public'
          AND pgboss_namespace.nspname = 'pgboss'`,
    );

    expect(ownership.rows[0]).toEqual({
      database_owner: 'clinic_migrator',
      public_owner: 'clinic_migrator',
      pgboss_owner: 'clinic_worker',
    });
  });

  it('grants each schema only to the roles that need it', async () => {
    const privileges = await harness.adminPool.query<{
      app_create_public: boolean;
      worker_create_public: boolean;
      app_usage_public: boolean;
      worker_usage_public: boolean;
      app_usage_pgboss: boolean;
      worker_usage_pgboss: boolean;
      app_usage_meta: boolean;
      worker_usage_meta: boolean;
      migrator_usage_meta: boolean;
    }>(
      `SELECT has_schema_privilege('clinic_app', 'public', 'CREATE')     AS app_create_public,
              has_schema_privilege('clinic_worker', 'public', 'CREATE')  AS worker_create_public,
              has_schema_privilege('clinic_app', 'public', 'USAGE')      AS app_usage_public,
              has_schema_privilege('clinic_worker', 'public', 'USAGE')   AS worker_usage_public,
              has_schema_privilege('clinic_app', 'pgboss', 'USAGE')      AS app_usage_pgboss,
              has_schema_privilege('clinic_worker', 'pgboss', 'USAGE')   AS worker_usage_pgboss,
              has_schema_privilege('clinic_app', 'clinik_meta', 'USAGE') AS app_usage_meta,
              has_schema_privilege('clinic_worker', 'clinik_meta', 'USAGE') AS worker_usage_meta,
              has_schema_privilege('clinic_migrator', 'clinik_meta', 'USAGE') AS migrator_usage_meta`,
    );

    expect(privileges.rows[0]).toEqual({
      app_create_public: false,
      worker_create_public: false,
      app_usage_public: true,
      worker_usage_public: true,
      app_usage_pgboss: false,
      worker_usage_pgboss: true,
      app_usage_meta: false,
      worker_usage_meta: false,
      migrator_usage_meta: true,
    });
  });

  it('refuses object creation by runtime roles in schemas they do not own', async () => {
    await expectSqlState(
      harness.appPool.query('CREATE TABLE public.app_should_not_create (id integer)'),
      ['42501'],
    );
    await expectSqlState(
      harness.workerPool.query('CREATE TABLE public.worker_should_not_create (id integer)'),
      ['42501'],
    );
    await expectSqlState(
      harness.appPool.query('CREATE TABLE pgboss.app_should_not_create (id integer)'),
      ['42501'],
    );
    await expectSqlState(
      harness.appPool.query('CREATE TABLE clinik_meta.app_should_not_create (id integer)'),
      ['42501'],
    );
    await expectSqlState(
      harness.workerPool.query('CREATE TABLE clinik_meta.worker_should_not_create (id integer)'),
      ['42501'],
    );
  });

  it('allows clinic_worker to create objects only in its pgboss schema', async () => {
    await harness.workerPool.query('CREATE TABLE pgboss.worker_queue_probe (id integer)');
    await harness.workerPool.query('DROP TABLE pgboss.worker_queue_probe');
  });

  it('keeps clinik_meta migration storage away from runtime roles', async () => {
    await expectSqlState(
      harness.appPool.query('SELECT count(*) FROM clinik_meta.schema_migrations'),
      ['42501'],
    );
    await expectSqlState(
      harness.workerPool.query('SELECT count(*) FROM clinik_meta.schema_migrations'),
      ['42501'],
    );
    const migrated = await harness.migratorPool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM clinik_meta.schema_migrations',
    );
    expect(migrated.rows[0]?.count).toBeGreaterThan(0);
  });

  it('does not allow runtime roles to SET ROLE into the migrator', async () => {
    await expectSqlState(harness.appPool.query('SET ROLE clinic_migrator'), ['42501']);
    await expectSqlState(harness.workerPool.query('SET ROLE clinic_migrator'), ['42501']);
  });

  it('rejects cross-tenant inserts, organization reassignment and deletes for clinic_app', async () => {
    await withTenantTransaction(appDatabase, { orgId: organizationA }, async (tx) => {
      await tx.execute(
        sql`INSERT INTO test_tenant_rows (id, organization_id) VALUES (10, ${organizationA})`,
      );
      const visible = await tx.execute(sql`SELECT id FROM test_tenant_rows ORDER BY id`);
      expect(visible.rows.map((row) => row.id)).toEqual([1, 10]);
    });

    await expectSqlState(
      withTenantTransaction(appDatabase, { orgId: organizationA }, async (tx) => {
        await tx.execute(
          sql`INSERT INTO test_tenant_rows (id, organization_id) VALUES (11, ${organizationB})`,
        );
      }),
      ['42501'],
    );

    await expectSqlState(
      withTenantTransaction(appDatabase, { orgId: organizationA }, async (tx) => {
        await tx.execute(
          sql`UPDATE test_tenant_rows SET organization_id = ${organizationB} WHERE id = 1`,
        );
      }),
      ['42501'],
    );

    const updateOtherTenant = await withTenantTransaction(
      appDatabase,
      { orgId: organizationA },
      async (tx) => tx.execute(sql`UPDATE test_tenant_rows SET id = id WHERE id = 2`),
    );
    expect(updateOtherTenant.rowCount).toBe(0);

    const deleteOtherTenant = await withTenantTransaction(
      appDatabase,
      { orgId: organizationA },
      async (tx) => tx.execute(sql`DELETE FROM test_tenant_rows WHERE id = 2`),
    );
    expect(deleteOtherTenant.rowCount).toBe(0);

    const deleteOwnTenant = await withTenantTransaction(
      appDatabase,
      { orgId: organizationA },
      async (tx) => tx.execute(sql`DELETE FROM test_tenant_rows WHERE id = 1`),
    );
    expect(deleteOwnTenant.rowCount).toBe(1);
  });

  it('limits clinic_worker to its explicit grants and tenant context', async () => {
    const visible = await withTenantTransaction(workerDatabase, { orgId: organizationA }, (tx) =>
      tx.execute(sql`SELECT id, organization_id FROM test_tenant_rows`),
    );
    expect(visible.rows).toHaveLength(1);
    expect(visible.rows[0]?.organization_id).toBe(organizationA);

    await expectSqlState(
      withTenantTransaction(workerDatabase, { orgId: organizationA }, async (tx) => {
        await tx.execute(
          sql`INSERT INTO test_tenant_rows (id, organization_id) VALUES (12, ${organizationB})`,
        );
      }),
      ['42501'],
    );

    await expectSqlState(
      withTenantTransaction(workerDatabase, { orgId: organizationA }, async (tx) => {
        await tx.execute(
          sql`UPDATE test_tenant_rows SET organization_id = ${organizationB} WHERE id = 1`,
        );
      }),
      ['42501'],
    );

    await expectSqlState(
      withTenantTransaction(workerDatabase, { orgId: organizationA }, async (tx) => {
        await tx.execute(sql`DELETE FROM test_tenant_rows WHERE id = 1`);
      }),
      ['42501'],
    );

    const updateOtherTenant = await withTenantTransaction(
      workerDatabase,
      { orgId: organizationA },
      (tx) => tx.execute(sql`UPDATE test_tenant_rows SET id = id WHERE id = 2`),
    );
    expect(updateOtherTenant.rowCount).toBe(0);

    const updateOwnTenant = await withTenantTransaction(
      workerDatabase,
      { orgId: organizationA },
      (tx) => tx.execute(sql`UPDATE test_tenant_rows SET id = id WHERE id = 1`),
    );
    expect(updateOwnTenant.rowCount).toBe(1);
  });

  it('grants migration helpers to clinic_migrator only', async () => {
    await harness.migratorPool.query(
      `SELECT public.attach_set_updated_at('${tenantRows}'::regclass)`,
    );
    await harness.migratorPool.query(`SELECT public.attach_tenant_rls('${tenantRows}'::regclass)`);

    await expectSqlState(
      harness.appPool.query(`SELECT public.attach_set_updated_at('${tenantRows}'::regclass)`),
      ['42501'],
    );
    await expectSqlState(
      harness.appPool.query(`SELECT public.attach_tenant_rls('${tenantRows}'::regclass)`),
      ['42501'],
    );
    await expectSqlState(
      harness.workerPool.query(`SELECT public.attach_set_updated_at('${tenantRows}'::regclass)`),
      ['42501'],
    );
    await expectSqlState(
      harness.workerPool.query(`SELECT public.attach_tenant_rls('${tenantRows}'::regclass)`),
      ['42501'],
    );
  });

  it('accepts the real runtime roles in the role self-check', async () => {
    const appState = await readRuntimeRoleState(harness.appPool);
    const workerState = await readRuntimeRoleState(harness.workerPool);

    expect(findRuntimeRoleViolations(appState, 'clinic_app')).toEqual([]);
    expect(findRuntimeRoleViolations(workerState, 'clinic_worker')).toEqual([]);
  });

  it('rejects a superuser connection in the role self-check', async () => {
    const state = await readRuntimeRoleState(harness.adminPool);
    const violations = findRuntimeRoleViolations(state, 'clinic_app');
    expect(violations.join(' ')).toMatch(/superuser/);
    expect(violations.join(' ')).toMatch(/connected as postgres/);
  });

  it('rejects a role with inherited membership in the role self-check', async () => {
    await harness.adminPool.query(
      `CREATE ROLE unsafe_inheritor LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD 'unsafe_inheritor_password'`,
    );
    await harness.adminPool.query('GRANT clinic_app TO unsafe_inheritor');
    const pool = new Pool({
      connectionString: roleConnection('unsafe_inheritor', 'unsafe_inheritor_password'),
      max: 1,
    });

    try {
      const state = await readRuntimeRoleState(pool);
      expect(state.roleMemberships).toBe(1);
      expect(findRuntimeRoleViolations(state, 'clinic_app').join(' ')).toMatch(/inherit/);
    } finally {
      await pool.end();
      await harness.adminPool.query('REVOKE clinic_app FROM unsafe_inheritor');
      await harness.adminPool.query('DROP ROLE unsafe_inheritor');
    }
  });

  it('rejects a runtime role that owns a protected public relation', async () => {
    await harness.adminPool.query(
      `CREATE ROLE unsafe_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD 'unsafe_owner_password'`,
    );
    await harness.adminPool.query('GRANT CREATE ON SCHEMA public TO unsafe_owner');
    const pool = new Pool({
      connectionString: roleConnection('unsafe_owner', 'unsafe_owner_password'),
      max: 1,
    });

    try {
      await pool.query('CREATE TABLE public.unsafe_owned (id integer)');
      const state = await readRuntimeRoleState(pool);
      expect(state.ownedPublicRelations).toBe(1);
      expect(findRuntimeRoleViolations(state, 'clinic_app').join(' ')).toMatch(/own relations/);
    } finally {
      await pool.end();
      await harness.adminPool.query('DROP TABLE IF EXISTS public.unsafe_owned');
      await harness.adminPool.query('REVOKE CREATE ON SCHEMA public FROM unsafe_owner');
      await harness.adminPool.query('DROP ROLE unsafe_owner');
    }
  });
});
