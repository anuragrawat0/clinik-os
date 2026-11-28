import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { HttpException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditWriter } from '../../src/core/audit';
import { DATABASE, DatabaseConnection } from '../../src/core/db/database.module';
import { logger } from '../../src/core/logging/logger';
import { PasswordService, SessionService, TokenService } from '../../src/modules/identity/core';
import { AUTH_MAIL_TRANSPORT } from '../../src/modules/notifications/auth-mailer';
import {
  type DatabaseHarness,
  organizationA,
  organizationB,
  startDatabaseHarness,
} from '../db/harness';

/**
 * Independent review of the M1 post-audit fix round (audit-report.md, B-1/M-3/M-5/m-3).
 * Expectations come from audit-report.md and the project docs, not from the code under test.
 */

const branchA = '20000000-0000-0000-0000-000000000001';
const orgPath = `/api/v1/orgs/${organizationA}`;
const password = 'Synthetic-post-audit-passphrase-73';
const fullName = 'Synthetic Post Audit';
const writeHeaders = { 'X-Requested-With': 'XMLHttpRequest', 'X-Request-Id': 'post-audit-review' };

const ownerRole = { role: 'org_owner', branchId: null } as const;
const adminRole = { role: 'org_admin', branchId: null } as const;

let harness: DatabaseHarness;
let app: INestApplication;
let port: number;
let passwordHash: string;
let tokens: TokenService;
let usersCreated = 0;

function call(method: 'get' | 'post' | 'patch' | 'delete', path: string, cookie?: string) {
  const req = request(app.getHttpServer())[method](path).set(writeHeaders);
  return cookie ? req.set('Cookie', cookie) : req;
}

function transfer(cookie: string, currentPassword: string, newOwnerUserId: string) {
  return call('post', `${orgPath}/ownership-transfer`, cookie).send({
    newOwnerUserId,
    currentPassword,
  });
}

async function createUser(): Promise<{ id: string; email: string }> {
  const email = `synthetic.postaudit.${++usersCreated}@clinik.test`;
  const result = await harness.adminPool.query<{ id: string }>(
    'INSERT INTO users (email, password_hash, full_name, status) VALUES ($1, $2, $3, $4) RETURNING id',
    [email, passwordHash, fullName, 'active'],
  );
  return { id: result.rows[0].id, email };
}

async function member(
  options: {
    orgId?: string;
    roles?: readonly { role: string; branchId: string | null }[];
  } = {},
) {
  const user = await createUser();
  if (options.orgId) {
    await harness.adminPool.query(
      'INSERT INTO organization_members (organization_id, user_id) VALUES ($1, $2)',
      [options.orgId, user.id],
    );
    for (const { role, branchId } of options.roles ?? [])
      await harness.adminPool.query(
        'INSERT INTO staff_role_assignments (organization_id, user_id, role, branch_id) VALUES ($1, $2, $3, $4)',
        [options.orgId, user.id, role, branchId],
      );
  }
  const { rawToken } = await app.get(SessionService).create(user.id, {
    ip: null,
    userAgent: null,
    requestId: null,
  });
  return { ...user, cookie: `__Host-session=${rawToken}` };
}

async function directInvitation(input: {
  email: string;
  role: string;
  branchId: string | null;
  invitedBy: string;
}): Promise<{ id: string; path: string }> {
  const token = tokens.generate();
  const result = await harness.adminPool.query<{ id: string }>(
    `INSERT INTO invitations (organization_id, email, role, branch_id, token_hash, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      organizationA,
      input.email,
      input.role,
      input.branchId,
      token.hash,
      input.invitedBy,
      new Date(Date.now() + 60 * 60 * 1000),
    ],
  );
  return { id: result.rows[0].id, path: `/api/v1/auth/invitations/${organizationA}.${token.raw}` };
}

function deferredSignal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function idleInTransaction(): Promise<number> {
  const { rows } = await harness.adminPool.query<{ count: number }>(
    `SELECT count(*)::integer AS count FROM pg_stat_activity
     WHERE application_name = 'clinik-api' AND state IN ('idle in transaction', 'idle in transaction (aborted)')`,
  );
  return rows[0].count;
}

async function denialRows() {
  const { rows } = await harness.adminPool.query(
    `SELECT action, outcome FROM audit_logs WHERE action = 'org.ownership_transfer.denied' ORDER BY id`,
  );
  return rows;
}

beforeAll(async () => {
  harness = await startDatabaseHarness();
  vi.stubEnv('DATABASE_URL', harness.connectionString('clinic_app'));
  vi.stubEnv('TRUSTED_PROXY_CIDRS', '');
  const { AppModule } = await import('../../src/app.module');
  const { configureHttpApp } = await import('../../src/http-app');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(AUTH_MAIL_TRANSPORT)
    .useValue({ sendMail: async () => undefined })
    .compile();
  app = moduleRef.createNestApplication();
  configureHttpApp(app);
  await app.init();
  await app.listen(0);
  port = (app.getHttpServer().address() as AddressInfo).port;
  passwordHash = await app.get(PasswordService).hash(password);
  tokens = app.get(TokenService);
}, 180_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await app?.close();
  await harness?.stop();
});

beforeEach(async () => {
  await harness.adminPool.query('TRUNCATE users, organizations, audit_logs CASCADE');
  await harness.adminPool.query(
    `INSERT INTO organizations (id, name, slug) VALUES
       ($1, 'Clinic A', 'clinic-a'), ($2, 'Clinic B', 'clinic-b')`,
    [organizationA, organizationB],
  );
  await harness.adminPool.query(
    `INSERT INTO branches (id, organization_id, name, code, timezone) VALUES ($1, $2, 'Main Branch', 'MAIN', 'UTC')`,
    [branchA, organizationA],
  );
});

describe('B-1: the in-flight re-auth guard is always released', () => {
  it('is released when the transfer throws mid-flight', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const target = await member({ orgId: organizationA, roles: [adminRole] });
    const verify = vi
      .spyOn(app.get(PasswordService), 'verify')
      .mockRejectedValueOnce(new TypeError('Synthetic mid-flight failure'));
    try {
      const failed = await transfer(owner.cookie, 'wrong-password', target.id);
      expect(failed.status).toBe(500);
      expect(failed.body.code).toBe('REQUEST_FAILED');
    } finally {
      verify.mockRestore();
    }

    const next = await transfer(owner.cookie, 'wrong-password', target.id);
    expect(next.status).not.toBe(429);
    expect(next.status).toBe(422);
    expect(next.body.code).toBe('INVALID_PASSWORD');
    expect(await idleInTransaction()).toBe(0);
  }, 30_000);

  it('is released when the client aborts mid-flight', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const target = await member({ orgId: organizationA, roles: [adminRole] });
    const entered = deferredSignal();
    const release = deferredSignal();
    const verify = vi.spyOn(app.get(PasswordService), 'verify').mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return false;
    });
    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${port}${orgPath}/ownership-transfer`, {
      method: 'POST',
      headers: { ...writeHeaders, 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({ newOwnerUserId: target.id, currentPassword: 'wrong-password' }),
      signal: controller.signal,
    }).then(
      () => 'responded',
      () => 'aborted',
    );
    try {
      await Promise.race([
        entered.promise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('The transfer did not start')), 10_000).unref(),
        ),
      ]);
      controller.abort();
      release.resolve();
      expect(await pending).toBe('aborted');
    } finally {
      release.resolve();
      verify.mockRestore();
    }

    await vi.waitFor(async () => expect(await denialRows()).toHaveLength(1), { timeout: 10_000 });
    const next = await transfer(owner.cookie, 'wrong-password', target.id);
    expect(next.status).not.toBe(429);
    expect(next.status).toBe(422);
    expect(await idleInTransaction()).toBe(0);
  }, 30_000);
});

describe('B-1: overlapping re-auth requests', () => {
  it('does not count a 429 toward the five-failure limit', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const target = await member({ orgId: organizationA, roles: [adminRole] });
    const entered = deferredSignal();
    const release = deferredSignal();
    const verify = vi.spyOn(app.get(PasswordService), 'verify').mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return false;
    });
    const first = transfer(owner.cookie, 'wrong-password', target.id).then((response) => response);
    let overlap: request.Response | undefined;
    try {
      await Promise.race([
        entered.promise,
        first.then(({ status }) => {
          throw new Error(`The first attempt finished during setup: ${status}`);
        }),
      ]);
      overlap = await transfer(owner.cookie, 'wrong-password', target.id);
      expect(overlap.status).toBe(429);
      expect(overlap.headers['content-type']).toContain('application/problem+json');
      expect(overlap.body.code).toBe('REAUTH_IN_PROGRESS');
    } finally {
      release.resolve();
      verify.mockRestore();
      await first;
    }
    expect((await first).status).toBe(422);
    expect(await denialRows()).toHaveLength(1);

    for (let attempt = 0; attempt < 3; attempt += 1)
      expect((await transfer(owner.cookie, 'wrong-password', target.id)).status).toBe(422);
    const fifth = await transfer(owner.cookie, 'wrong-password', target.id);
    expect(fifth.status).toBe(401);
    expect(fifth.body.code).toBe('UNAUTHENTICATED');
    expect(await denialRows()).toHaveLength(5);

    const sixth = await transfer(owner.cookie, 'wrong-password', target.id);
    expect(sixth.status).toBe(401);
    expect(await denialRows()).toHaveLength(5);
  }, 30_000);

  it('answers 401 on the fifth denial when logout has already revoked the session', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const target = await member({ orgId: organizationA, roles: [adminRole] });
    for (let attempt = 0; attempt < 4; attempt += 1)
      await transfer(owner.cookie, 'wrong-password', target.id).expect(422);

    const sessions = app.get(SessionService);
    const revokeSession = sessions.revoke.bind(sessions);
    const revoke = vi.spyOn(sessions, 'revoke').mockImplementationOnce(async (...args) => {
      await call('post', '/api/v1/auth/logout', owner.cookie).expect(204);
      return revokeSession(...args);
    });
    try {
      const fifth = await transfer(owner.cookie, 'wrong-password', target.id).expect(401);
      expect(fifth.body.code).toBe('UNAUTHENTICATED');
      expect(revoke.mock.calls.map(([, options]) => options?.reason)).toEqual([
        'reauth_failed',
        'logout',
      ]);
      await expect(revoke.mock.results[0].value).resolves.toBe(false);
      await expect(revoke.mock.results[1].value).resolves.toBe(true);
      expect(await denialRows()).toHaveLength(5);
      await call('get', '/api/v1/auth/me', owner.cookie).expect(401);
    } finally {
      revoke.mockRestore();
    }
  }, 30_000);
});

describe('B-1: post-rollback hooks and the connection pool', () => {
  it('releases every connection when a rollback hook throws', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const target = await member({ orgId: organizationA, roles: [adminRole] });
    const { pool } = app.get<DatabaseConnection>(DATABASE);
    const audit = vi
      .spyOn(AuditWriter.prototype, 'record')
      .mockRejectedValueOnce(new HttpException({ code: 'SERVICE_UNAVAILABLE' }, 503));
    try {
      const failed = await transfer(owner.cookie, 'wrong-password', target.id);
      expect(failed.status).toBe(503);
      expect(failed.body.code).toBe('SERVICE_UNAVAILABLE');
      await vi.waitFor(
        async () => {
          expect(await idleInTransaction()).toBe(0);
          expect(pool.idleCount).toBe(pool.totalCount);
        },
        { timeout: 10_000 },
      );
      expect(pool.totalCount).toBeLessThanOrEqual(10);
    } finally {
      audit.mockRestore();
    }
    await call('get', '/api/v1/health').expect(200);
  }, 30_000);
});

describe('M-5: database timeouts', () => {
  it('applies the timeouts to clinic_app and clinic_worker but not the migrator role', async () => {
    const { pool } = app.get<DatabaseConnection>(DATABASE);
    expect(pool.options.connectionTimeoutMillis).toBe(5_000);
    expect(pool.options.statement_timeout).toBe(10_000);
    expect(pool.options.idle_in_transaction_session_timeout).toBe(15_000);
    const client = await pool.connect();
    try {
      const statement = await client.query<{ statement_timeout: string }>('SHOW statement_timeout');
      const idle = await client.query<{ idle_in_transaction_session_timeout: string }>(
        'SHOW idle_in_transaction_session_timeout',
      );
      expect(statement.rows[0].statement_timeout).toBe('10s');
      expect(idle.rows[0].idle_in_transaction_session_timeout).toBe('15s');
    } finally {
      client.release();
    }

    const worker = new DatabaseConnection(
      harness.connectionString('clinic_worker'),
      'clinic_worker',
      'clinik-worker-review',
    );
    try {
      expect(worker.pool.options.connectionTimeoutMillis).toBe(5_000);
      expect(worker.pool.options.statement_timeout).toBe(10_000);
      const statement = await worker.pool.query<{ statement_timeout: string }>(
        'SHOW statement_timeout',
      );
      expect(statement.rows[0].statement_timeout).toBe('10s');
    } finally {
      await worker.pool.end();
    }

    const migrator = new Pool({
      connectionString: harness.connectionString('clinic_migrator'),
      max: 1,
      application_name: 'review-migrator-timeouts',
    });
    try {
      const statement = await migrator.query<{ statement_timeout: string }>(
        'SHOW statement_timeout',
      );
      const idle = await migrator.query<{ idle_in_transaction_session_timeout: string }>(
        'SHOW idle_in_transaction_session_timeout',
      );
      expect(statement.rows[0].statement_timeout).toBe('0');
      expect(idle.rows[0].idle_in_transaction_session_timeout).toBe('0');
    } finally {
      await migrator.end();
    }
  }, 30_000);

  it('answers 503 with a diagnosable log line and no PHI when the pool cannot be acquired', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const { pool } = app.get<DatabaseConnection>(DATABASE);
    const clients: Awaited<ReturnType<typeof pool.connect>>[] = [];
    const log = vi.spyOn(logger, 'error');
    try {
      for (let index = 0; index < 10; index += 1) clients.push(await pool.connect());
      const response = await call('get', `${orgPath}/members`, owner.cookie)
        .timeout({ response: 8_000 })
        .expect(503);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.body.code).toBe('SERVICE_UNAVAILABLE');
      expect(String(response.headers['cache-control'])).toContain('no-store');
      const failures = log.mock.calls.filter(([, message]) => message === 'HTTP request failed');
      expect(failures).toHaveLength(1);
      expect(failures[0][0]).toMatchObject({
        requestId: response.body.requestId,
        errorClass: 'Error',
        code: 'ETIMEDOUT',
      });
      const logged = JSON.stringify(failures);
      expect(logged).not.toContain(owner.email);
      expect(logged).not.toContain(fullName);
      expect(logged).not.toContain('postgresql://');
    } finally {
      for (const client of clients) client.release();
      log.mockRestore();
    }
    await call('get', '/api/v1/health').expect(200);
    expect(await idleInTransaction()).toBe(0);
  }, 40_000);
});

describe('M-3: an inviter whose grant authority shrinks', () => {
  it('rejects a pending invitation after the owner transfers ownership away', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const target = await member({ orgId: organizationA, roles: [adminRole] });
    const invitation = await directInvitation({
      email: 'former-owner-invite@clinik.test',
      role: 'org_admin',
      branchId: null,
      invitedBy: owner.id,
    });
    const transferred = await transfer(owner.cookie, password, target.id);
    expect(transferred.status).toBe(204);

    const roles = await harness.adminPool.query(
      'SELECT user_id, role FROM staff_role_assignments WHERE organization_id = $1 ORDER BY role',
      [organizationA],
    );
    expect(roles.rows).toEqual([
      { user_id: owner.id, role: 'org_admin' },
      { user_id: target.id, role: 'org_owner' },
    ]);

    const accepted = await call('post', `${invitation.path}/accept`).send({
      fullName,
      password,
    });
    expect(accepted.status).toBe(404);
    expect(accepted.body.code).toBe('NOT_FOUND');
    const { rows } = await harness.adminPool.query(
      'SELECT accepted_at FROM invitations WHERE id = $1',
      [invitation.id],
    );
    expect(rows).toEqual([{ accepted_at: null }]);
  }, 30_000);
});

describe('M-2: time zones already stored as a legacy alias', () => {
  it('reads back, keeps on an unrelated PATCH, and canonicalizes on a timezone PATCH', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    await harness.adminPool.query(
      "UPDATE organizations SET default_timezone = 'Asia/Calcutta' WHERE id = $1",
      [organizationA],
    );

    const read = await call('get', orgPath, owner.cookie).expect(200);
    expect(read.body.defaultTimezone).toBe('Asia/Calcutta');

    const renamed = await call('patch', orgPath, owner.cookie)
      .send({ name: 'Renamed Clinic' })
      .expect(200);
    expect(renamed.body.name).toBe('Renamed Clinic');
    expect(renamed.body.defaultTimezone).toBe('Asia/Calcutta');

    const canonical = await call('patch', orgPath, owner.cookie)
      .send({ defaultTimezone: 'Asia/Calcutta' })
      .expect(200);
    expect(canonical.body.defaultTimezone).toBe('Asia/Kolkata');
    const { rows } = await harness.adminPool.query(
      'SELECT name, default_timezone FROM organizations WHERE id = $1',
      [organizationA],
    );
    expect(rows).toEqual([{ name: 'Renamed Clinic', default_timezone: 'Asia/Kolkata' }]);
  }, 30_000);
});

describe('m-2: cache headers and ETags', () => {
  it('marks tenant JSON as no-store, marks problem responses as no-store, and leaves health alone', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const members = await call('get', `${orgPath}/members`, owner.cookie).expect(200);
    expect(String(members.headers['cache-control'])).toContain('no-store');
    expect(members.headers.etag).toBeUndefined();
    expect(members.headers['x-powered-by']).toBeUndefined();

    const missing = await call('get', `/api/v1/orgs/${randomUUID()}/members`, owner.cookie).expect(
      404,
    );
    expect(missing.headers['content-type']).toContain('application/problem+json');
    expect(String(missing.headers['cache-control'])).toContain('no-store');
    expect(missing.headers.etag).toBeUndefined();

    const health = await call('get', '/api/v1/health').expect(200);
    expect(health.headers['cache-control']).toBeUndefined();
    expect(health.headers.etag).toBeUndefined();
  }, 30_000);
});

describe('m-3: rows stored before name validation tightened', () => {
  it('does not block an unrelated PATCH on an organization whose stored name has a control character', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    await harness.adminPool.query(
      `UPDATE organizations SET name = 'Clinic' || chr(10) || 'A' WHERE id = $1`,
      [organizationA],
    );

    const updated = await call('patch', orgPath, owner.cookie)
      .send({ defaultTimezone: 'Asia/Kolkata' })
      .expect(200);
    expect(updated.body.defaultTimezone).toBe('Asia/Kolkata');
    const { rows } = await harness.adminPool.query(
      'SELECT name, default_timezone FROM organizations WHERE id = $1',
      [organizationA],
    );
    expect(rows).toEqual([{ name: 'Clinic\nA', default_timezone: 'Asia/Kolkata' }]);
  }, 30_000);
});
