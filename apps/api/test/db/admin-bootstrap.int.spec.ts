import 'reflect-metadata';
import { spawn } from 'node:child_process';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClockModule } from '../../src/core/clock/clock';
import { DatabaseModule } from '../../src/core/db/database.module';
import { AuthService, IdentityCoreModule } from '../../src/modules/identity/core';
import { startDatabaseHarness, type DatabaseHarness } from './harness';

const name = 'Synthetic Demo Admin';
const password = 'A-synthetic-bootstrap-passphrase-47';
const meta = { ip: null, userAgent: null, requestId: null };
let harness: DatabaseHarness;
let testingModule: TestingModule;

function bootstrap(
  email: string,
  input: string,
  databaseUrl: string | null = harness.connectionString('clinic_app'),
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/cli/create-admin.ts', '--email', email, '--name', name],
      { env: { ...process.env, DATABASE_URL: databaseUrl ?? undefined } },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function readUsers(email: string) {
  return (
    await harness.adminPool.query<{
      id: string;
      password_hash: string;
      full_name: string;
      status: string;
      email_verified_at: Date | null;
      is_platform_admin: boolean;
    }>(
      'SELECT id, password_hash, full_name, status, email_verified_at, is_platform_admin FROM users WHERE email = $1',
      [email],
    )
  ).rows;
}

async function readAudits() {
  return (
    await harness.adminPool.query(
      `SELECT organization_id, actor_user_id, actor_type, resource_type, resource_id, outcome, metadata
       FROM audit_logs WHERE action = 'platform_admin.created' ORDER BY id`,
    )
  ).rows;
}

beforeAll(async () => {
  harness = await startDatabaseHarness();
  const database = DatabaseModule.forRuntimeRole(
    harness.connectionString('clinic_app'),
    'clinic_app',
    'clinik-test-bootstrap-auth',
  );
  testingModule = await Test.createTestingModule({
    imports: [ClockModule, IdentityCoreModule.register({ database, trustedProxyCidrs: [] })],
  }).compile();
  await testingModule.init();
}, 180_000);

afterAll(async () => {
  await testingModule?.close();
  await harness?.stop();
});

describe('platform admin bootstrap CLI', () => {
  it('reads one line from stdin, creates an active verified admin and audits it in the same operation', async () => {
    const email = 'demo-admin@clinik.test';
    const previousAudits = await readAudits();
    const output = await bootstrap(email, `${password}\r\nunused-line\r\n`);
    expect(output.code).toBe(0);
    const [user] = await readUsers(email);
    expect(user).toMatchObject({
      full_name: name,
      status: 'active',
      is_platform_admin: true,
      email_verified_at: expect.any(Date),
      password_hash: expect.stringMatching(/^\$argon2id\$/),
    });
    expect(output).toEqual({ code: 0, stdout: `${user.id}\n`, stderr: '' });
    expect(await readAudits()).toEqual([
      ...previousAudits,
      {
        organization_id: null,
        actor_user_id: null,
        actor_type: 'system',
        resource_type: 'user',
        resource_id: user.id,
        outcome: 'success',
        metadata: {},
      },
    ]);
    const result = await testingModule.get(AuthService).login(email, password, meta);
    expect(result).toMatchObject({ ok: true, user: { id: user.id, isPlatformAdmin: true } });
  });

  it('exits 1 on an existing email (including case variants) without promoting it or writing audit', async () => {
    const email = 'existing-staff@clinik.test';
    await harness.adminPool.query('INSERT INTO users (email, full_name) VALUES ($1, $2)', [
      email,
      'Existing User',
    ]);
    const before = await readUsers(email);
    const audits = await readAudits();
    expect(await bootstrap(email.toUpperCase(), `${password}\n`)).toEqual({
      code: 1,
      stdout: '',
      stderr: 'EMAIL_EXISTS\n',
    });
    expect(await readUsers(email)).toEqual(before);
    expect(await readAudits()).toEqual(audits);
  });

  it.each([
    ['PASSWORD_TOO_SHORT', 'weak'],
    ['PASSWORD_TOO_LONG', 'a'.repeat(129)],
    ['PASSWORD_TOO_COMMON', 'password1234'],
    ['PASSWORD_CONTAINS_EMAIL', 'Includes-weak-bootstrap-48'],
  ])('exits 2 with %s without writing or echoing the password', async (code, candidate) => {
    const email = 'weak-bootstrap@clinik.test';
    const audits = await readAudits();
    expect(await bootstrap(email, `${candidate}\n`)).toEqual({
      code: 2,
      stdout: '',
      stderr: `${code}\n`,
    });
    expect(await readUsers(email)).toEqual([]);
    expect(await readAudits()).toEqual(audits);
  });

  it('exits 2 with a fixed diagnostic when DATABASE_URL is missing', async () => {
    expect(await bootstrap('missing-url@clinik.test', '', null)).toEqual({
      code: 2,
      stdout: '',
      stderr: 'DATABASE_URL_MISSING\n',
    });
  });

  it.each([
    ['refused connection', 'DB_CONNECT_FAILED', { port: '1' }],
    ['wrong password', 'DB_AUTH_FAILED', { password: 'synthetic-wrong-database-secret' }],
    ['missing database', 'DB_NOT_FOUND', { pathname: '/synthetic_missing_database' }],
  ])('exits 3 for %s without exposing connection details', async (_case, code, overrides) => {
    const email = 'connect-error@clinik.test';
    const url = Object.assign(new URL(harness.connectionString('clinic_app')), overrides);
    const audits = await readAudits();
    expect(await bootstrap(email, `${password}\n`, url.href)).toEqual({
      code: 3,
      stdout: '',
      stderr: `${code}\n`,
    });
    expect(await readUsers(email)).toEqual([]);
    expect(await readAudits()).toEqual(audits);
  });

  it('maps PostgreSQL SQLSTATE 28000 to DB_AUTH_FAILED', async () => {
    await harness.adminPool.query('ALTER ROLE clinic_worker NOLOGIN');
    try {
      expect(
        await bootstrap(
          'cannot-login@clinik.test',
          `${password}\n`,
          harness.connectionString('clinic_worker'),
        ),
      ).toEqual({
        code: 3,
        stdout: '',
        stderr: 'DB_AUTH_FAILED\n',
      });
    } finally {
      await harness.adminPool.query('ALTER ROLE clinic_worker LOGIN');
    }
  });

  it('rejects a malformed DATABASE_URL without echoing it', async () => {
    expect(await bootstrap('malformed-url@clinik.test', '', 'synthetic-invalid-secret')).toEqual({
      code: 3,
      stdout: '',
      stderr: 'DB_CONNECT_FAILED\n',
    });
  });

  it('rejects non-app database roles without exposing connection or password details', async () => {
    const email = 'wrong-db-role@clinik.test';
    const audits = await readAudits();
    expect(
      await bootstrap(email, `${password}\n`, harness.connectionString('clinic_migrator')),
    ).toEqual({
      code: 4,
      stdout: '',
      stderr: 'ADMIN_CREATE_FAILED\n',
    });
    expect(await readUsers(email)).toEqual([]);
    expect(await readAudits()).toEqual(audits);
  });

  it('rolls back the user when the audit insert fails', async () => {
    const email = 'rollback-admin@clinik.test';
    const audits = await readAudits();
    await harness.adminPool.query('REVOKE INSERT ON audit_logs FROM clinic_app');
    try {
      expect(await bootstrap(email, `${password}\n`)).toEqual({
        code: 4,
        stdout: '',
        stderr: 'ADMIN_CREATE_FAILED\n',
      });
      expect(await readUsers(email)).toEqual([]);
      expect(await readAudits()).toEqual(audits);
    } finally {
      await harness.adminPool.query('GRANT INSERT ON audit_logs TO clinic_app');
    }
  });
});
