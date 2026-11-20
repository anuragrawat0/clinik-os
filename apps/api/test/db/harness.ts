import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { runMigrations } from '../../src/core/db/migrate';

export const databaseName = 'clinik_test';
export const migratorPassword = 'test_migrator_password';
export const appPassword = 'test_app_password';
export const workerPassword = 'test_worker_password';
export const organizationA = '10000000-0000-0000-0000-000000000001';
export const organizationB = '10000000-0000-0000-0000-000000000002';
export const tenantRows = 'public.test_tenant_rows';
export const bootstrapScriptPath = resolve(process.cwd(), '../../database/bootstrap/001-roles.sh');
export const migrationsDirectory = resolve(process.cwd(), 'migrations');

export interface DatabaseHarness {
  container: StartedPostgreSqlContainer;
  adminPool: Pool;
  migratorPool: Pool;
  appPool: Pool;
  workerPool: Pool;
  connectionString(role: 'clinic_migrator' | 'clinic_app' | 'clinic_worker'): string;
  resetTenantRows(): Promise<void>;
  stop(): Promise<void>;
}

function rolePassword(role: 'clinic_migrator' | 'clinic_app' | 'clinic_worker'): string {
  if (role === 'clinic_migrator') return migratorPassword;
  if (role === 'clinic_app') return appPassword;
  return workerPassword;
}

export async function startDatabaseHarness(): Promise<DatabaseHarness> {
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase(databaseName)
    .withUsername('postgres')
    .withPassword('postgres')
    .withEnvironment({
      DB_NAME: databaseName,
      CLINIC_MIGRATOR_PASSWORD: migratorPassword,
      CLINIC_APP_PASSWORD: appPassword,
      CLINIC_WORKER_PASSWORD: workerPassword,
    })
    .withCopyFilesToContainer([
      { source: bootstrapScriptPath, target: '/tmp/001-roles.sh', mode: 0o755 },
    ])
    .start();

  const bootstrap = await container.exec(['bash', '/tmp/001-roles.sh'], {
    env: {
      POSTGRES_USER: 'postgres',
      DB_NAME: databaseName,
      CLINIC_MIGRATOR_PASSWORD: migratorPassword,
      CLINIC_APP_PASSWORD: appPassword,
      CLINIC_WORKER_PASSWORD: workerPassword,
    },
  });
  if (bootstrap.exitCode !== 0) {
    await container.stop();
    throw new Error(`Role bootstrap failed (${bootstrap.exitCode}): ${bootstrap.output}`);
  }

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const connectionString = (role: 'clinic_migrator' | 'clinic_app' | 'clinic_worker'): string =>
    `postgresql://${role}:${rolePassword(role)}@${host}:${port}/${databaseName}`;

  const adminPool = new Pool({ connectionString: container.getConnectionUri(), max: 2 });
  const migratorPool = new Pool({
    connectionString: connectionString('clinic_migrator'),
    max: 2,
    application_name: 'clinik-test-migrator',
  });

  try {
    await runMigrations(connectionString('clinic_migrator'), 'up', migrationsDirectory);

    await migratorPool.query(`
      CREATE TABLE ${tenantRows} (
        id integer PRIMARY KEY,
        organization_id uuid NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      SELECT public.attach_tenant_rls('${tenantRows}'::regclass);
      SELECT public.attach_set_updated_at('${tenantRows}'::regclass);
      GRANT SELECT, INSERT, UPDATE ON ${tenantRows} TO clinic_worker;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ${tenantRows} TO clinic_app;
    `);
  } catch (error) {
    await Promise.all([adminPool.end(), migratorPool.end()]);
    await container.stop();
    throw error;
  }

  const appPool = new Pool({
    connectionString: connectionString('clinic_app'),
    max: 2,
    application_name: 'clinik-test-app',
  });
  const workerPool = new Pool({
    connectionString: connectionString('clinic_worker'),
    max: 2,
    application_name: 'clinik-test-worker',
  });

  async function resetTenantRows(): Promise<void> {
    await adminPool.query(`TRUNCATE ${tenantRows}`);
    await adminPool.query(
      `INSERT INTO ${tenantRows} (id, organization_id) VALUES (1, $1), (2, $2)`,
      [organizationA, organizationB],
    );
  }

  await resetTenantRows();

  async function stop(): Promise<void> {
    await Promise.allSettled([
      appPool.end(),
      workerPool.end(),
      migratorPool.end(),
      adminPool.end(),
    ]);
    await container.stop();
  }

  return {
    container,
    adminPool,
    migratorPool,
    appPool,
    workerPool,
    connectionString,
    resetTenantRows,
    stop,
  };
}
