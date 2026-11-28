import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DATABASE, type DatabaseConnection } from '../../src/core/db/database.module';
import { PasswordService, SessionService } from '../../src/modules/identity/core';
import { AUTH_MAIL_TRANSPORT } from '../../src/modules/notifications/auth-mailer';
import {
  type DatabaseHarness,
  organizationA,
  organizationB,
  startDatabaseHarness,
} from '../db/harness';

/**
 * Audit 2026-11-28 (master c32e772). Each test states the behaviour the audit expects.
 * A failing test documents a finding in audit-report.md; it is not a regression of a passing test.
 */

const branchA = '20000000-0000-0000-0000-000000000001';
const orgPath = `/api/v1/orgs/${organizationA}`;
const password = 'Synthetic-audit-passphrase-41';
const headers = { 'X-Requested-With': 'XMLHttpRequest' };

let harness: DatabaseHarness;
let app: INestApplication;
let superuser: Pool;
let passwordHash: string;
let sent: { to: unknown; text?: string }[] = [];
let created = 0;

async function member(roles: readonly { role: string; branchId: string | null }[]) {
  const email = `audit.${++created}@clinik.test`;
  const {
    rows: [user],
  } = await harness.adminPool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, status) VALUES ($1, $2, 'Audit User', 'active') RETURNING id`,
    [email, passwordHash],
  );
  await harness.adminPool.query(
    'INSERT INTO organization_members (organization_id, user_id) VALUES ($1, $2)',
    [organizationA, user.id],
  );
  for (const { role, branchId } of roles)
    await harness.adminPool.query(
      'INSERT INTO staff_role_assignments (organization_id, user_id, role, branch_id) VALUES ($1, $2, $3, $4)',
      [organizationA, user.id, role, branchId],
    );
  const { rawToken } = await app
    .get(SessionService)
    .create(user.id, { ip: null, userAgent: null, requestId: null });
  return { id: user.id, email, cookie: `__Host-session=${rawToken}` };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'TIMEOUT'> {
  return Promise.race([
    promise,
    new Promise<'TIMEOUT'>((resolve) => setTimeout(() => resolve('TIMEOUT'), ms).unref()),
  ]);
}

beforeAll(async () => {
  harness = await startDatabaseHarness();
  vi.stubEnv('DATABASE_URL', harness.connectionString('clinic_app'));
  vi.stubEnv('TRUSTED_PROXY_CIDRS', '');
  const { AppModule } = await import('../../src/app.module');
  const { configureHttpApp } = await import('../../src/http-app');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(AUTH_MAIL_TRANSPORT)
    .useValue({
      sendMail: async (message: { to: unknown; text?: string }) => {
        sent.push(message);
      },
    })
    .compile();
  app = moduleRef.createNestApplication();
  configureHttpApp(app);
  await app.init();
  await app.listen(0);
  void (app.getHttpServer().address() as AddressInfo).port;
  passwordHash = await app.get(PasswordService).hash(password);
  const pool = app.get<DatabaseConnection>(DATABASE).pool;
  pool.on('error', () => undefined);
  pool.on('connect', (client) => client.on('error', () => undefined));
  superuser = new Pool({ connectionString: harness.container.getConnectionUri(), max: 2 });
}, 180_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await superuser?.end();
  await app?.close();
  await harness?.stop();
});

beforeEach(async () => {
  sent = [];
  await harness.adminPool.query('TRUNCATE users, organizations, audit_logs CASCADE');
  await harness.adminPool.query(
    `INSERT INTO organizations (id, name, slug) VALUES ($1, 'Clinic A', 'clinic-a'), ($2, 'Clinic B', 'clinic-b')`,
    [organizationA, organizationB],
  );
  await harness.adminPool.query(
    `INSERT INTO branches (id, organization_id, name, code, timezone) VALUES ($1, $2, 'Main', 'MAIN', 'UTC')`,
    [branchA, organizationA],
  );
});

describe('AUDIT B5: API response headers', () => {
  it('does not advertise the framework (X-Powered-By) and sends nosniff', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/health');
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('marks tenant responses that carry staff emails and names as Cache-Control: no-store', async () => {
    const owner = await member([{ role: 'org_owner', branchId: null }]);
    const response = await request(app.getHttpServer())
      .get(`${orgPath}/members`)
      .set('Cookie', owner.cookie);
    expect(response.status).toBe(200);
    expect(response.body[0].email).toBe(owner.email);
    expect(String(response.headers['cache-control'] ?? '')).toContain('no-store');
  });
});

describe('AUDIT B3: invitations issued by a member who is later removed', () => {
  it('cannot be accepted after the inviter is removed from the organization', async () => {
    const owner = await member([{ role: 'org_owner', branchId: null }]);
    const admin = await member([{ role: 'org_admin', branchId: null }]);
    const invite = await request(app.getHttpServer())
      .post(`${orgPath}/invitations`)
      .set(headers)
      .set('Cookie', admin.cookie)
      .send({ email: 'audit.invitee@clinik.test', role: 'branch_manager', branchId: branchA });
    expect(invite.status).toBe(201);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const link = /\/invite\/([0-9a-f-]{36}\.[A-Za-z0-9_-]{43})/.exec(String(sent[0].text))?.[1];
    expect(link).toBeDefined();

    const removed = await request(app.getHttpServer())
      .delete(`${orgPath}/members/${admin.id}`)
      .set(headers)
      .set('Cookie', owner.cookie);
    expect(removed.status).toBe(204);

    const accepted = await request(app.getHttpServer())
      .post(`/api/v1/auth/invitations/${link}/accept`)
      .set(headers)
      .send({ fullName: 'Audit Invitee', password: 'Synthetic-invitee-passphrase-9' });
    // Expected: the removed admin's outstanding grant no longer works (404 like any dead invite).
    expect(accepted.status).toBe(404);
  });
});

describe('AUDIT B1: unexpected errors', () => {
  it('logs the class of an unexpected (500) error instead of discarding it', async () => {
    const { ProblemDetailsFilter } = await import('../../src/core/errors/problem-details.filter');
    const { logger } = await import('../../src/core/logging/logger');
    const spy = vi.spyOn(logger, 'error');
    const response = {
      setHeader: vi.fn(),
      status: vi.fn(() => response),
      type: vi.fn(() => response),
      json: vi.fn(() => response),
    };
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ originalUrl: '/api/v1/orgs/x/members', id: 'audit-req' }),
        getResponse: () => response,
      }),
    };
    new ProblemDetailsFilter().catch(new TypeError('db exploded'), host as never);
    expect(response.status).toHaveBeenCalledWith(500);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

// Runs last: on failure it terminates the deadlocked backends.
describe('AUDIT B6: ownership-transfer denial path and the connection pool', () => {
  it('answers 12 concurrent wrong-password transfers and stays healthy (pool max 10)', async () => {
    const owner = await member([{ role: 'org_owner', branchId: null }]);
    const target = await member([{ role: 'doctor', branchId: branchA }]);
    const attempts = Array.from({ length: 12 }, () =>
      request(app.getHttpServer())
        .post(`${orgPath}/ownership-transfer`)
        .set(headers)
        .set('Cookie', owner.cookie)
        .send({ newOwnerUserId: target.id, currentPassword: 'definitely-not-the-password' }),
    );
    const outcome = await withTimeout(Promise.all(attempts), 20_000);
    const health =
      outcome === 'TIMEOUT'
        ? 'TIMEOUT'
        : await withTimeout(
            request(app.getHttpServer())
              .get('/api/v1/health')
              .then((r) => r.status),
            5_000,
          );
    if (outcome === 'TIMEOUT' || health === 'TIMEOUT') {
      // Unblock the deadlocked pool so the suite can shut down, then fail.
      const { rows } = await superuser.query<{ state: string; count: number }>(
        `SELECT state, count(*)::int AS count FROM pg_stat_activity
         WHERE application_name = 'clinik-api' GROUP BY state`,
      );
      console.warn('AUDIT pool state at timeout', JSON.stringify(rows));
      await superuser.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'clinik-api'`,
      );
      await withTimeout(Promise.allSettled(attempts), 10_000);
    }
    expect(outcome).not.toBe('TIMEOUT');
    expect(health).toBe(200);
    if (outcome === 'TIMEOUT') throw new Error('Expected transfer responses');
    expect(outcome.some(({ status }) => status === 422)).toBe(true);
    for (const response of outcome) {
      expect([401, 422, 429]).toContain(response.status);
      if (response.status === 429) {
        expect(response.headers['content-type']).toContain('application/problem+json');
        expect(response.body.code).toBe('REAUTH_IN_PROGRESS');
      }
    }
  }, 60_000);
});
