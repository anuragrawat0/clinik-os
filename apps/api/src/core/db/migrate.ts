import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { connectWithRetry } from './connect-with-retry';
import { logger } from '../logging/logger';

const migrationSchema = 'clinik_meta';
const advisoryLockKey = 1_947_120_026;

interface MigrationFiles {
  name: string;
  up: string;
  down: string;
  checksum: string;
}

function migrationChecksum(up: string, down: string): string {
  return createHash('sha256').update(up).update('\0').update(down).digest('hex');
}

async function readMigrations(directory: string): Promise<MigrationFiles[]> {
  const filenames = await readdir(directory);
  const upFiles = filenames
    .filter((filename) => /^\d+_[a-z0-9_-]+\.up\.sql$/.test(filename))
    .sort((left, right) => left.localeCompare(right));

  return Promise.all(
    upFiles.map(async (upFilename) => {
      const name = upFilename.replace(/\.up\.sql$/, '');
      const up = await readFile(resolve(directory, upFilename), 'utf8');
      const down = await readFile(resolve(directory, `${name}.down.sql`), 'utf8');
      return { name, up, down, checksum: migrationChecksum(up, down) };
    }),
  );
}

async function ensureMigrationTable(client: PoolClient): Promise<void> {
  await client.query(
    `CREATE SCHEMA IF NOT EXISTS ${migrationSchema} AUTHORIZATION clinic_migrator`,
  );
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${migrationSchema}.schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function runUp(client: PoolClient, migrations: MigrationFiles[]): Promise<void> {
  await ensureMigrationTable(client);
  const applied = await client.query<{ name: string; checksum: string }>(
    `SELECT name, checksum FROM ${migrationSchema}.schema_migrations ORDER BY name`,
  );
  const appliedByName = new Map(applied.rows.map((row) => [row.name, row.checksum]));

  for (const migration of migrations) {
    const existingChecksum = appliedByName.get(migration.name);
    if (existingChecksum) {
      if (existingChecksum !== migration.checksum) {
        throw new Error(
          `Applied migration ${migration.name} has changed; add a new migration instead.`,
        );
      }
      continue;
    }

    await client.query('BEGIN');
    try {
      await client.query(migration.up);
      await client.query(
        `INSERT INTO ${migrationSchema}.schema_migrations (name, checksum) VALUES ($1, $2)`,
        [migration.name, migration.checksum],
      );
      await client.query('COMMIT');
      logger.info({ migration: migration.name }, 'Database migration applied');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
}

async function runDown(client: PoolClient, migrations: MigrationFiles[]): Promise<void> {
  await ensureMigrationTable(client);
  const latest = await client.query<{ name: string; checksum: string }>(
    `SELECT name, checksum FROM ${migrationSchema}.schema_migrations ORDER BY name DESC LIMIT 1`,
  );
  const appliedMigration = latest.rows[0];
  if (!appliedMigration) {
    logger.info('No migration to roll back');
    return;
  }

  const migration = migrations.find((item) => item.name === appliedMigration.name);
  if (!migration || migration.checksum !== appliedMigration.checksum) {
    throw new Error(`Migration files are missing or changed for ${appliedMigration.name}.`);
  }

  await client.query('BEGIN');
  try {
    await client.query(migration.down);
    await client.query(`DELETE FROM ${migrationSchema}.schema_migrations WHERE name = $1`, [
      migration.name,
    ]);
    await client.query('COMMIT');
    logger.info({ migration: migration.name }, 'Database migration rolled back');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function runMigrations(
  connectionString: string,
  direction: 'up' | 'down' = 'up',
  migrationsDirectory = resolve(process.cwd(), 'migrations'),
): Promise<void> {
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 3_000,
    application_name: 'clinik-migrator',
  });
  let client: PoolClient | undefined;
  try {
    client = await connectWithRetry(() => pool.connect(), {
      onRetry: (attempt, code) =>
        logger.warn(
          { attempt, maxAttempts: 12, databaseErrorCode: code },
          'PostgreSQL is not ready; retrying migration connection',
        ),
    });
    const identity = await client.query<{ current_user: string; rolsuper: boolean }>(
      `SELECT current_user, roles.rolsuper
         FROM pg_roles AS roles
        WHERE roles.rolname = current_user`,
    );
    if (identity.rows[0]?.current_user !== 'clinic_migrator' || identity.rows[0].rolsuper) {
      throw new Error('Migrations must connect as the non-superuser clinic_migrator role.');
    }

    await client.query('SELECT pg_advisory_lock($1)', [advisoryLockKey]);
    const migrations = await readMigrations(migrationsDirectory);
    if (direction === 'up') {
      await runUp(client, migrations);
    } else {
      await runDown(client, migrations);
    }
  } finally {
    if (client) {
      await client.query('SELECT pg_advisory_unlock($1)', [advisoryLockKey]).catch(() => undefined);
      client.release();
    }
    await pool.end();
  }
}

async function main(): Promise<void> {
  const connectionString = process.env.MIGRATOR_DATABASE_URL;
  const direction = process.argv[2] ?? 'up';
  if (!connectionString) {
    throw new Error('MIGRATOR_DATABASE_URL is required to run migrations.');
  }
  if (direction !== 'up' && direction !== 'down') {
    throw new Error(`Unknown migration direction: ${direction}`);
  }
  await runMigrations(connectionString, direction);
}

if (process.argv[1]?.endsWith('migrate.js')) {
  main().catch((error: unknown) => {
    logger.fatal(
      { errorName: error instanceof Error ? error.name : 'UnknownError' },
      'Database migration failed',
    );
    process.exitCode = 1;
  });
}
