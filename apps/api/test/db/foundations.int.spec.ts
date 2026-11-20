import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/core/db/migrate';
import { runInTenant } from '../../src/core/jobs/run-in-tenant';
import { withTenantTransaction } from '../../src/core/db/transaction-context';
import { assertExpectedSqlState } from '../../src/core/db/trigger-test-helper';

const databaseName = 'clinik_test';
const migratorPassword = 'test_migrator_password';
const appPassword = 'test_app_password';
const workerPassword = 'test_worker_password';
const organizationA = '10000000-0000-0000-0000-000000000001';
const organizationB = '10000000-0000-0000-0000-000000000002';

let container: StartedPostgreSqlContainer;
let adminPool: Pool;
let appPool: Pool;
let workerPool: Pool;
let appDatabase: ReturnType<typeof drizzle>;
let workerDatabase: ReturnType<typeof drizzle>;

function connectionString(user: string, password: string): string {
  const host = container.getHost();
  const port = container.getMappedPort(5432);
  return `postgresql://${user}:${password}@${host}:${port}/${databaseName}`;
}

async function createRuntimeRoles(): Promise<void> {
  const createRole = async (name: string, password: string): Promise<void> => {
    const roleCommand = await adminPool.query<{ command: string }>(
      `SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD %L', $1::text, $2::text) AS command`,
      [name, password],
    );
    await adminPool.query(roleCommand.rows[0].command);
  };
  await createRole('clinic_migrator', migratorPassword);
  await createRole('clinic_app', appPassword);
  await createRole('clinic_worker', workerPassword);
  await adminPool.query(`ALTER DATABASE ${databaseName} OWNER TO clinic_migrator`);
  await adminPool.query('ALTER SCHEMA public OWNER TO clinic_migrator');
  await adminPool.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await adminPool.query(
    `GRANT CONNECT ON DATABASE ${databaseName} TO clinic_migrator, clinic_app, clinic_worker`,
  );
  await adminPool.query('GRANT USAGE ON SCHEMA public TO clinic_app, clinic_worker');
}

async function createTenantFixture(): Promise<void> {
  await adminPool.query('SET ROLE clinic_migrator');
  await adminPool.query(`
    CREATE SCHEMA tenant_test AUTHORIZATION clinic_migrator;
    CREATE TABLE tenant_test.tenant_rows (
      id integer PRIMARY KEY,
      organization_id uuid NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE tenant_test.tenant_rows ENABLE ROW LEVEL SECURITY;
    ALTER TABLE tenant_test.tenant_rows FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON tenant_test.tenant_rows
      USING (organization_id = public.app_current_org())
      WITH CHECK (organization_id = public.app_current_org());
    GRANT USAGE ON SCHEMA tenant_test TO clinic_app, clinic_worker;
    GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_test.tenant_rows TO clinic_app;
    GRANT SELECT, INSERT ON tenant_test.tenant_rows TO clinic_worker;
  `);
  await adminPool.query('RESET ROLE');
  await adminPool.query(
    `INSERT INTO tenant_test.tenant_rows (id, organization_id) VALUES (1, $1), (2, $2)`,
    [organizationA, organizationB],
  );
}

describe('M0 PostgreSQL foundation', () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase(databaseName)
      .withUsername('postgres')
      .withPassword('postgres')
      .start();
    const adminUrl = container.getConnectionUri();
    adminPool = new Pool({ connectionString: adminUrl, max: 1 });
    await createRuntimeRoles();
    await runMigrations(connectionString('clinic_migrator', migratorPassword), 'up', 'migrations');
    await createTenantFixture();

    appPool = new Pool({
      connectionString: connectionString('clinic_app', appPassword),
      max: 1,
      application_name: 'clinik-test-app',
    });
    workerPool = new Pool({
      connectionString: connectionString('clinic_worker', workerPassword),
      max: 1,
      application_name: 'clinik-test-worker',
    });
    appDatabase = drizzle(appPool);
    workerDatabase = drizzle(workerPool);
  }, 120_000);

  afterAll(async () => {
    await Promise.all([appPool?.end(), workerPool?.end(), adminPool?.end()]);
    await container?.stop();
  });

  it('connects as non-superuser, non-BYPASSRLS runtime roles', async () => {
    const identities = await Promise.all([
      appPool.query(
        'SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
      ),
      workerPool.query(
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
    const owner = await adminPool.query(
      `SELECT tableowner FROM pg_tables WHERE schemaname = 'tenant_test' AND tablename = 'tenant_rows'`,
    );
    expect(owner.rows[0]?.tableowner).toBe('clinic_migrator');
  });

  it.each<[string, () => Pool]>([
    ['clinic_app', () => appPool],
    ['clinic_worker', () => workerPool],
  ])('%s sees no tenant rows without transaction context (W1)', async (_role, getPool) => {
    const result = await getPool().query('SELECT id FROM tenant_test.tenant_rows');
    expect(result.rowCount).toBe(0);
  });

  it('rejects a worker insert without transaction-local tenant context (W2)', async () => {
    try {
      await workerPool.query(
        'INSERT INTO tenant_test.tenant_rows (id, organization_id) VALUES (3, $1)',
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
        const result = await tx.execute(
          sql`SELECT id, organization_id FROM tenant_test.tenant_rows`,
        );
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

    const nextJobContext = await workerPool.query(
      'SELECT public.app_current_org() AS org_id, current_setting($1, true) AS setting',
      ['app.current_org_id'],
    );
    expect(nextJobContext.rows[0]).toEqual({ org_id: null, setting: '' });
  });

  it('allows runInTenant through clinic_worker and limits it to the supplied organization', async () => {
    const visibleRows = await runInTenant(workerDatabase, organizationB, async (tx) => {
      const result = await tx.execute(sql`SELECT id, organization_id FROM tenant_test.tenant_rows`);
      return result.rows;
    });
    expect(visibleRows).toHaveLength(1);
    expect(visibleRows[0]?.organization_id).toBe(organizationB);
  });

  it('attaches the shared updated-at trigger to tables that have the column (T1)', async () => {
    await adminPool.query(
      `SELECT public.attach_set_updated_at('tenant_test.tenant_rows'::regclass)`,
    );
    const before = await adminPool.query(
      'SELECT updated_at FROM tenant_test.tenant_rows WHERE organization_id = $1',
      [organizationA],
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    await withTenantTransaction(appDatabase, { orgId: organizationA }, async (tx) => {
      await tx.execute(
        sql`UPDATE tenant_test.tenant_rows SET id = id WHERE organization_id = ${organizationA}`,
      );
    });
    const after = await adminPool.query(
      'SELECT updated_at FROM tenant_test.tenant_rows WHERE organization_id = $1',
      [organizationA],
    );
    expect(after.rows[0]?.updated_at.getTime()).toBeGreaterThan(
      before.rows[0]?.updated_at.getTime(),
    );
  });
});
