import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createTransport, type SendMailOptions } from 'nodemailer';
import { symbols, type DestinationStream } from 'pino';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOCK } from '../../src/core/clock/clock';
import { logger } from '../../src/core/logging/logger';
import {
  AuthTokenService,
  PasswordService,
  RESET_TOKEN_TTL_MS,
  TokenService,
  VERIFY_TOKEN_TTL_MS,
} from '../../src/modules/identity/core';
import { AUTH_MAIL_TRANSPORT, AuthMailer } from '../../src/modules/notifications/auth-mailer';
import {
  type DatabaseHarness,
  organizationA,
  organizationB,
  startDatabaseHarness,
} from '../db/harness';
import { FakeClock, HOUR, MINUTE } from '../helpers/fake-clock';

const prefix = '/api/v1/auth';
const writeHeaders = {
  'X-Requested-With': 'XMLHttpRequest',
  'X-Request-Id': 'auth-http-test',
};
const password = 'Synthetic-staff-passphrase-27';
const newPassword = 'Revised-synthetic-passphrase-72';
const fullName = 'Synthetic Staff';
const branch = '20000000-0000-0000-0000-000000000001';

interface CapturedMail {
  to: { address: string }[];
  subject: string;
  text: string;
}

let harness: DatabaseHarness;
let app: INestApplication;
let passwordHash: string;
let tokens: TokenService;
let authTokens: AuthTokenService;
let usersCreated = 0;
const clock = new FakeClock();
const messages: CapturedMail[] = [];
const exposedSecrets = new Set([password, newPassword]);
const output: string[] = [];
const transport = createTransport({ jsonTransport: true });
const sendMail = vi.fn(async (message: SendMailOptions) => {
  const captured = await transport.sendMail(message);
  messages.push(JSON.parse(captured.message) as CapturedMail);
});

function http() {
  return request(app.getHttpServer());
}

function post(path: string) {
  return http()
    .post(prefix + path)
    .set(writeHeaders);
}

function get(path: string) {
  return http()
    .get(prefix + path)
    .set('X-Request-Id', writeHeaders['X-Request-Id']);
}

function cookieFrom(res: Response): string {
  const header = (res.headers['set-cookie'] as string[] | undefined)?.[0];
  const cookie = header?.split(';')[0];
  if (!cookie) throw new Error('Expected a session cookie');
  exposedSecrets.add(cookie.slice('__Host-session='.length));
  return cookie;
}

function assertProblem(res: Response, code: string) {
  expect(res.type).toBe('application/problem+json');
  expect(res.body).toMatchObject({ status: res.status, code });
}

function publicResponse(res: Response) {
  const headers = { ...res.headers };
  delete headers.date;
  return { status: res.status, body: res.text, headers };
}

async function createUser(status = 'active'): Promise<{ id: string; email: string }> {
  const email = `Synthetic.Staff.${++usersCreated}@clinik.test`;
  const result = await harness.adminPool.query<{ id: string }>(
    'INSERT INTO users (email, password_hash, full_name, status) VALUES ($1, $2, $3, $4) RETURNING id',
    [email, passwordHash, fullName, status],
  );
  return { id: result.rows[0].id, email };
}

async function createInvitation(
  email: string,
  options: { expiresAt?: Date; acceptedAt?: Date; revokedAt?: Date } = {},
) {
  const token = tokens.generate();
  exposedSecrets.add(token.raw);
  const result = await harness.adminPool.query<{ id: string }>(
    `INSERT INTO invitations (organization_id, email, role, branch_id, token_hash, invited_by,
                              expires_at, accepted_at, revoked_at)
     VALUES ($1, $2, 'doctor', $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      organizationA,
      email,
      branch,
      token.hash,
      (await createUser()).id,
      options.expiresAt ?? new Date(clock.now().getTime() + HOUR),
      options.acceptedAt ?? null,
      options.revokedAt ?? null,
    ],
  );
  return {
    id: result.rows[0].id,
    path: `/invitations/${organizationA}.${token.raw}`,
    raw: token.raw,
  };
}

async function signIn(email: string): Promise<string> {
  return cookieFrom(await post('/login').send({ email, password }).expect(200));
}

async function auditRows() {
  const result = await harness.adminPool.query(
    'SELECT action, outcome, actor_user_id, organization_id, resource_id, metadata FROM audit_logs ORDER BY id',
  );
  return result.rows;
}

async function waitForBlockedRequests(count: number, blockerPid: number | null = null) {
  return vi.waitFor(
    async () => {
      const { rows } = await harness.adminPool.query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity
       WHERE application_name = 'clinik-api'
         AND cardinality(pg_blocking_pids(pid)) > 0
         AND ($1::integer IS NULL OR $1 = ANY(pg_blocking_pids(pid)))`,
        [blockerPid],
      );
      expect(rows).toHaveLength(count);
      return rows;
    },
    { timeout: 10_000 },
  );
}

async function withAuditWriteBlocked(
  run: (blockerPid: number, start: (request: PromiseLike<Response>) => void) => Promise<void>,
): Promise<Response[]> {
  const gate = await harness.adminPool.connect();
  const pending: Promise<Response>[] = [];
  try {
    await gate.query('BEGIN');
    await gate.query('LOCK TABLE audit_logs IN ACCESS EXCLUSIVE MODE');
    const { rows } = await gate.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    await run(rows[0].pid, (request) => {
      const response = Promise.resolve(request);
      void response.catch(() => {});
      pending.push(response);
    });
  } finally {
    try {
      await gate.query('ROLLBACK');
    } finally {
      gate.release();
      await Promise.allSettled(pending);
    }
  }
  return Promise.all(pending);
}

function mailToken(message: CapturedMail, path: string): string {
  const [link] = message.text.match(/http:\/\/127\.0\.0\.1:3000\/\S+/) ?? [];
  if (!link) throw new Error('Expected the configured web link in the email');
  const url = new URL(link);
  expect(url.pathname).toBe(path);
  const raw = url.searchParams.get('token');
  if (!raw) throw new Error('Expected a token in the email');
  exposedSecrets.add(raw);
  return raw;
}

beforeAll(async () => {
  const stream = (logger as unknown as Record<typeof symbols.streamSym, DestinationStream>)[
    symbols.streamSym
  ];
  vi.spyOn(stream, 'write').mockImplementation((chunk) => output.push(chunk));
  harness = await startDatabaseHarness();
  vi.stubEnv('DATABASE_URL', harness.connectionString('clinic_app'));
  vi.stubEnv('TRUSTED_PROXY_CIDRS', '');
  vi.stubEnv('APP_BASE_URL', 'http://127.0.0.1:3000');
  const { AppModule } = await import('../../src/app.module');
  const { configureHttpApp } = await import('../../src/http-app');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CLOCK)
    .useValue(clock)
    .overrideProvider(AUTH_MAIL_TRANSPORT)
    .useValue({ sendMail })
    .compile();
  app = moduleRef.createNestApplication();
  configureHttpApp(app);
  await app.init();
  passwordHash = await moduleRef.get(PasswordService).hash(password);
  exposedSecrets.add(passwordHash);
  tokens = moduleRef.get(TokenService);
  authTokens = moduleRef.get(AuthTokenService);
}, 180_000);

afterAll(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await app?.close();
  await harness?.stop();
});

beforeEach(async () => {
  messages.length = 0;
  sendMail.mockClear();
  clock.advance(HOUR);
  await harness.adminPool.query('TRUNCATE users, organizations, audit_logs CASCADE');
  await harness.adminPool.query(
    `INSERT INTO organizations (id, name, slug) VALUES ($1, 'Clinic A', 'clinic-a'), ($2, 'Clinic B', 'clinic-b')`,
    [organizationA, organizationB],
  );
  await harness.adminPool.query(
    `INSERT INTO branches (id, organization_id, name, code, timezone) VALUES ($1, $2, 'Main Branch', 'MAIN', 'UTC')`,
    [branch, organizationA],
  );
});

describe('auth HTTP', () => {
  it('sets the exact host cookie, returns only the caller’s memberships and logs out', async () => {
    const user = await createUser();
    const other = await createUser();
    await harness.adminPool.query(
      'INSERT INTO organization_members (organization_id, user_id) VALUES ($1, $2), ($3, $4), ($1, $4)',
      [organizationA, user.id, organizationB, other.id],
    );
    await harness.adminPool.query(
      `INSERT INTO staff_role_assignments (organization_id, user_id, role, branch_id)
       VALUES ($1, $2, 'doctor', $3), ($1, $4, 'receptionist', $3)`,
      [organizationA, user.id, branch, other.id],
    );
    const login = await post('/login').send({ email: user.email, password }).expect(200);
    expect(login.body.user).toEqual({
      ...user,
      fullName,
      isPlatformAdmin: false,
      emailVerifiedAt: null,
    });
    const cookie = cookieFrom(login);
    const headers = login.headers['set-cookie'] as string[];
    expect(headers).toHaveLength(1);
    const attributes = headers[0].split('; ').slice(1);
    expect(attributes.find((value) => value.startsWith('Expires='))).toBeDefined();
    expect(attributes.filter((value) => !value.startsWith('Expires=')).sort()).toEqual([
      'HttpOnly',
      'Max-Age=43200',
      'Path=/',
      'SameSite=Lax',
      'Secure',
    ]);
    const me = await get('/me').set('Cookie', cookie).expect(200);
    expect(me.body).toEqual({
      user: login.body.user,
      patientProfiles: [],
      memberships: [
        {
          organizationId: organizationA,
          organizationName: 'Clinic A',
          status: 'active',
          organizationStatus: 'active',
          roles: [{ role: 'doctor', branchId: branch }],
        },
      ],
    });
    const logout = await post('/logout').set('Cookie', cookie).expect(204);
    expect(String(logout.headers['set-cookie'])).toContain('__Host-session=;');
    assertProblem(await get('/me').set('Cookie', cookie).expect(401), 'UNAUTHENTICATED');
    expect(await auditRows()).toMatchObject([
      { action: 'auth.login.success', actor_user_id: user.id, organization_id: null },
      { action: 'auth.logout', actor_user_id: user.id, organization_id: null },
    ]);
  });

  it('returns byte-identical credential failures and rate-limits the real peer', async () => {
    const active = await createUser();
    const locked = await createUser();
    const disabled = await createUser('disabled');
    const pending = await createUser('pending');
    await harness.adminPool.query('UPDATE users SET locked_until = $1 WHERE id = $2', [
      new Date(clock.now().getTime() + 15 * MINUTE),
      locked.id,
    ]);
    const unknown = 'unknown@clinik.test';
    const attempts = [
      { email: unknown, password },
      { email: active.email, password: newPassword },
      { email: locked.email, password },
      { email: disabled.email, password },
      { email: pending.email, password },
    ];
    const first = await post('/login').send(attempts[0]).expect(401);
    assertProblem(first, 'INVALID_CREDENTIALS');
    for (const attempt of attempts.slice(1)) {
      expect(publicResponse(await post('/login').send(attempt).expect(401))).toEqual(
        publicResponse(first),
      );
    }
    for (let i = 6; i <= 20; i += 1) {
      await post('/login').set('X-Forwarded-For', `192.0.2.${i}`).send(attempts[0]).expect(401);
    }
    const limited = await post('/login')
      .set('X-Forwarded-For', '192.0.2.21')
      .send(attempts[0])
      .expect(429);
    assertProblem(limited, 'RATE_LIMITED');
    const retryAfter = Number(limited.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
    const rows = await auditRows();
    expect(rows).toHaveLength(20);
    expect(rows.slice(0, 5).map(({ metadata }) => metadata.reason)).toEqual([
      'unknown_email',
      'bad_password',
      'locked',
      'inactive',
      'inactive',
    ]);
  });

  it.each(['reset', 'login'] as const)(
    'serializes concurrent login and reset with %s first, with no surviving old-password session',
    async (first) => {
      const second = first === 'reset' ? 'login' : 'reset';
      for (let iteration = 0; iteration < 8; iteration += 1) {
        clock.advance(MINUTE);
        const user = await createUser();
        const cookie = await signIn(user.email);
        const token = await authTokens.issue(user.id, 'password_reset');
        exposedSecrets.add(token);
        const request = {
          login: () => post('/login').set('Cookie', cookie).send({ email: user.email, password }),
          reset: () => post('/password/reset').send({ token, password: newPassword }),
        };
        const [firstResponse, secondResponse] = await withAuditWriteBlocked(
          async (gatePid, start) => {
            start(request[first]());
            const [blocked] = await waitForBlockedRequests(1, gatePid);
            start(request[second]());
            await waitForBlockedRequests(1, blocked.pid);
          },
        );

        const reset = first === 'reset' ? firstResponse : secondResponse;
        const login = first === 'login' ? firstResponse : secondResponse;
        expect(reset.status).toBe(204);
        if (first === 'reset') {
          assertProblem(login, 'INVALID_CREDENTIALS');
          expect(login.status).toBe(401);
          const wrong = await post('/login').send({ email: user.email, password }).expect(401);
          expect(publicResponse(login)).toEqual(publicResponse(wrong));
          const failures = (await auditRows()).filter(
            ({ action, actor_user_id }) =>
              action === 'auth.login.failure' && actor_user_id === user.id,
          );
          expect(failures.map(({ metadata }) => metadata)).toEqual([
            { reason: 'bad_password' },
            { reason: 'bad_password' },
          ]);
        } else {
          expect(login.status).toBe(200);
          await get('/me').set('Cookie', cookieFrom(login)).expect(401);
        }
        const { rowCount } = await harness.adminPool.query(
          'SELECT id FROM sessions WHERE user_id = $1 AND revoked_at IS NULL',
          [user.id],
        );
        expect(rowCount).toBe(0);
      }
    },
    90_000,
  );

  it('lists and revokes only own sessions', async () => {
    const user = await createUser();
    const other = await createUser();
    const first = await signIn(user.email);
    const second = await signIn(user.email);
    const otherCookie = await signIn(other.email);
    const own = await get('/sessions').set('Cookie', first).expect(200);
    const foreign = await get('/sessions').set('Cookie', otherCookie).expect(200);
    expect(own.body).toHaveLength(2);
    const current = own.body.find((entry: { current: boolean }) => entry.current);
    const old = own.body.find((entry: { current: boolean }) => !entry.current);
    const foreignId = foreign.body[0].id;
    expect(own.body.map((entry: { id: string }) => entry.id)).not.toContain(foreignId);
    expect(current).not.toHaveProperty('userId');
    const revoke = (id: string) =>
      http().delete(`${prefix}/sessions/${id}`).set(writeHeaders).set('Cookie', first);
    assertProblem(await revoke(foreignId).expect(404), 'NOT_FOUND');
    await revoke(old.id).expect(204);
    await get('/me').set('Cookie', second).expect(401);
    await get('/me').set('Cookie', otherCookie).expect(200);
    const self = await revoke(current.id).expect(204);
    expect(String(self.headers['set-cookie'])).toContain('__Host-session=;');
    expect(
      (await auditRows()).filter(({ action }) => action === 'auth.session.revoked'),
    ).toMatchObject([
      { actor_user_id: user.id, resource_id: old.id },
      { actor_user_id: user.id, resource_id: current.id },
    ]);
  });

  it('answers forgot uniformly and queues committed reset mail without waiting for delivery', async () => {
    const user = await createUser();
    const disabled = await createUser('disabled');
    const first = await signIn(user.email);
    const second = await signIn(user.email);
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    sendMail.mockImplementationOnce(async (message) => {
      expect((await auditRows()).at(-1)).toMatchObject({
        action: 'auth.password_reset.requested',
        outcome: 'success',
      });
      await blocked;
      await transport.sendMail(message).then((captured) => {
        messages.push(JSON.parse(captured.message) as CapturedMail);
      });
    });
    try {
      const known = await post('/password/forgot')
        .send({ email: user.email.toLowerCase() })
        .expect(202);
      expect(known.body).toEqual({ accepted: true });
      await vi.waitFor(() => expect(sendMail).toHaveBeenCalledTimes(1));
      expect(messages).toHaveLength(0);
      for (const email of [
        'unknown@clinik.test',
        disabled.email,
        'malformed',
        'another@clinik.test',
        user.email,
        user.email,
      ]) {
        const other = await post('/password/forgot').send({ email }).expect(202);
        expect(publicResponse(other)).toEqual(publicResponse(known));
      }
    } finally {
      release();
    }
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0].to).toEqual([{ address: user.email, name: '' }]);
    const token = mailToken(messages[0], '/reset-password');
    assertProblem(
      await post('/password/reset').send({ token, password: 'short' }).expect(422),
      'PASSWORD_TOO_SHORT',
    );
    await post('/password/reset').send({ token, password: newPassword }).expect(204);
    assertProblem(
      await post('/password/reset').send({ token, password: newPassword }).expect(400),
      'INVALID_TOKEN',
    );
    await get('/me').set('Cookie', first).expect(401);
    await get('/me').set('Cookie', second).expect(401);
    await post('/login').send({ email: user.email, password: newPassword }).expect(200);
    expect(await auditRows()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'auth.session.revoked',
          metadata: expect.objectContaining({ reason: 'password_reset', count: 2 }),
        }),
        expect.objectContaining({ action: 'auth.password_reset.completed', outcome: 'success' }),
      ]),
    );
  });

  it('rejects expired reset and verify links and accepts a verification token only once', async () => {
    const user = await createUser();
    const reset = await authTokens.issue(user.id, 'password_reset');
    exposedSecrets.add(reset);
    clock.advance(RESET_TOKEN_TTL_MS);
    assertProblem(
      await post('/password/reset').send({ token: reset, password: newPassword }).expect(400),
      'INVALID_TOKEN',
    );

    const expired = await authTokens.issue(user.id, 'email_verify');
    exposedSecrets.add(expired);
    clock.advance(VERIFY_TOKEN_TTL_MS);
    assertProblem(
      await post('/email/verify').send({ token: expired }).expect(400),
      'INVALID_TOKEN',
    );
    const valid = await authTokens.issue(user.id, 'email_verify');
    await app.get(AuthMailer).send('email_verify', valid, async () => user.email);
    const token = mailToken(messages[0], '/verify-email');
    expect(token).toBe(valid);
    await post('/email/verify').send({ token }).expect(204);
    assertProblem(await post('/email/verify').send({ token }).expect(400), 'INVALID_TOKEN');
    const { rows } = await harness.adminPool.query(
      'SELECT email_verified_at FROM users WHERE id = $1',
      [user.id],
    );
    expect(rows[0].email_verified_at).toEqual(clock.now());
    expect(
      (await auditRows()).filter(({ action }) => action === 'auth.email.verified'),
    ).toMatchObject([
      { outcome: 'denied' },
      { outcome: 'success', actor_user_id: user.id },
      { outcome: 'denied' },
    ]);
  });

  it('keeps exactly one usable reset token after five overlapping forgot requests', async () => {
    const user = await createUser();
    const forgot = () => post('/password/forgot').send({ email: user.email });
    const responses = await withAuditWriteBlocked(async (gatePid, start) => {
      start(forgot());
      await waitForBlockedRequests(1, gatePid);
      for (let i = 0; i < 4; i += 1) start(forgot());
      await waitForBlockedRequests(5);
    });
    for (const response of responses) {
      expect(response.status).toBe(202);
      expect(response.body).toEqual({ accepted: true });
    }

    const { rows } = await harness.adminPool.query(
      `SELECT count(*)::integer AS issued,
              count(*) FILTER (WHERE consumed_at IS NULL AND expires_at > $2)::integer AS active
       FROM auth_tokens WHERE user_id = $1 AND purpose = 'password_reset'`,
      [user.id, clock.now()],
    );
    expect(rows).toEqual([{ issued: 5, active: 1 }]);
    await vi.waitFor(() => expect(messages).toHaveLength(5));
  }, 30_000);

  it('returns the remaining shared token-verify window for both reset and verification', async () => {
    const reset = () =>
      post('/password/reset').send({ token: 'unknown-token', password: newPassword });
    const verify = () => post('/email/verify').send({ token: 'unknown-token' });
    await verify().expect(400);
    clock.advance(50_000);
    for (let i = 0; i < 29; i += 1) await reset().expect(400);

    for (const attempt of [reset, verify]) {
      const response = await attempt().expect(429);
      assertProblem(response, 'RATE_LIMITED');
      expect(response.headers['retry-after']).toBe('10');
    }
    clock.advance(10_000);
    await verify().expect(400);
  });

  it('requires CSRF for every POST and DELETE even on public routes', async () => {
    for (const path of [
      '/login',
      '/logout',
      '/password/forgot',
      '/password/reset',
      '/email/verify',
      '/invitations/bad/accept',
    ]) {
      assertProblem(
        await http()
          .post(prefix + path)
          .expect(403),
        'CSRF_REJECTED',
      );
    }
    assertProblem(
      await http()
        .delete(prefix + '/sessions/invalid')
        .expect(403),
      'CSRF_REJECTED',
    );
  });
});

describe('staff invitation HTTP', () => {
  it('previews only invitation details and atomically creates the verified account, membership, role, audit and session', async () => {
    const email = 'invited@clinik.test';
    const invitation = await createInvitation(email);
    const preview = await get(invitation.path).expect(200);
    expect(preview.body).toEqual({
      organizationName: 'Clinic A',
      role: 'doctor',
      branchName: 'Main Branch',
      email,
    });
    const accepted = await post(invitation.path + '/accept')
      .send({ fullName, password })
      .expect(204);
    const me = await get('/me').set('Cookie', cookieFrom(accepted)).expect(200);
    expect(me.body.user).toMatchObject({
      email,
      fullName,
      emailVerifiedAt: clock.now().toISOString(),
    });
    expect(me.body.memberships).toMatchObject([
      { organizationId: organizationA, roles: [{ role: 'doctor', branchId: branch }] },
    ]);
    const { rows } = await harness.adminPool.query(
      'SELECT password_hash, status FROM users WHERE id = $1',
      [me.body.user.id],
    );
    expect(rows[0]).toMatchObject({
      password_hash: expect.stringMatching(/^\$argon2id\$/),
      status: 'active',
    });
    expect((await harness.appPool.query('SELECT * FROM staff_role_assignments')).rows).toEqual([]);
    const appClient = await harness.appPool.connect();
    try {
      await appClient.query('BEGIN');
      await appClient.query("SELECT set_config('app.current_org_id', $1, true)", [organizationA]);
      expect(
        (await appClient.query('SELECT user_id, status FROM organization_members')).rows,
      ).toEqual([{ user_id: me.body.user.id, status: 'active' }]);
      expect(
        (await appClient.query('SELECT user_id, role, branch_id FROM staff_role_assignments')).rows,
      ).toEqual([{ user_id: me.body.user.id, role: 'doctor', branch_id: branch }]);
      await appClient.query("SELECT set_config('app.current_org_id', $1, true)", [organizationB]);
      expect((await appClient.query('SELECT * FROM organization_members')).rows).toEqual([]);
      expect((await appClient.query('SELECT * FROM staff_role_assignments')).rows).toEqual([]);
    } finally {
      await appClient.query('ROLLBACK');
      appClient.release();
    }
    expect(await auditRows()).toMatchObject([
      {
        action: 'invitation.accepted',
        organization_id: organizationA,
        resource_id: invitation.id,
        actor_user_id: me.body.user.id,
      },
    ]);
  });

  it('keeps an invitation pending when a new user submits a password that fails policy', async () => {
    const email = 'policy-invite@clinik.test';
    const invitation = await createInvitation(email);
    const accept = (password: string) =>
      post(invitation.path + '/accept').send({ fullName, password });
    assertProblem(await accept('short').expect(422), 'PASSWORD_TOO_SHORT');

    const { rows } = await harness.adminPool.query(
      `SELECT accepted_at, revoked_at,
              (SELECT count(*)::integer FROM users WHERE email = $2) AS users,
              (SELECT count(*)::integer FROM organization_members WHERE organization_id = $3) AS members,
              (SELECT count(*)::integer FROM staff_role_assignments WHERE organization_id = $3) AS roles
       FROM invitations WHERE id = $1`,
      [invitation.id, email, organizationA],
    );
    expect(rows).toEqual([{ accepted_at: null, revoked_at: null, users: 0, members: 0, roles: 0 }]);
    await get(invitation.path).expect(200);
    const accepted = await accept(password).expect(204);
    const profile = await get('/me').set('Cookie', cookieFrom(accepted)).expect(200);
    expect(profile.body.user.email).toBe(email);
  });

  it('requires the matching session for an existing user and keeps their password', async () => {
    const user = await createUser();
    const other = await createUser();
    const invitation = await createInvitation(user.email.toLowerCase());
    const path = invitation.path + '/accept';
    const empty = await post(path).send({}).expect(401);
    assertProblem(empty, 'UNAUTHENTICATED');
    expect(
      publicResponse(
        await post(path)
          .set('Cookie', await signIn(other.email))
          .send({})
          .expect(401),
      ),
    ).toEqual(publicResponse(empty));
    expect(
      publicResponse(await post(path).send({ fullName, password: newPassword }).expect(401)),
    ).toEqual(publicResponse(empty));
    const current = await signIn(user.email);
    const session = await post(path)
      .set('Cookie', current)
      .send({ fullName, password: newPassword })
      .expect(204);
    const accepted = cookieFrom(session);
    expect(accepted).not.toBe(current);
    await get('/me').set('Cookie', current).expect(401);
    const me = await get('/me').set('Cookie', accepted).expect(200);
    expect(me.body.user.id).toBe(user.id);
    const { rows } = await harness.adminPool.query(
      'SELECT password_hash FROM users WHERE id = $1',
      [user.id],
    );
    expect(rows[0].password_hash).toBe(passwordHash);
  });

  it('returns the same secret-free 404 for malformed, unknown, cross-tenant, expired, revoked and accepted links', async () => {
    const email = 'unavailable@clinik.test';
    const valid = await createInvitation(email);
    const expired = await createInvitation('expired@clinik.test', { expiresAt: clock.now() });
    const revoked = await createInvitation('revoked@clinik.test', { revokedAt: clock.now() });
    const accepted = await createInvitation('accepted@clinik.test', { acceptedAt: clock.now() });
    const missing = [
      '/invitations/malformed',
      '/invitations/%',
      `/invitations/${organizationA}.${tokens.generate().raw}`,
      `/invitations/${organizationB}.${valid.raw}`,
      expired.path,
      revoked.path,
      accepted.path,
    ];
    const baseline = await get(missing[0]).expect(404);
    assertProblem(baseline, 'NOT_FOUND');
    for (const path of missing) {
      expect(publicResponse(await get(path).expect(404))).toEqual(publicResponse(baseline));
      expect(
        publicResponse(
          await post(path + '/accept')
            .send({ fullName, password })
            .expect(404),
        ),
      ).toEqual(publicResponse(baseline));
    }
  });

  it('allows exactly one concurrent acceptance and writes one grant and audit row', async () => {
    const invitation = await createInvitation('concurrent@clinik.test');
    const apply = () => post(invitation.path + '/accept').send({ fullName, password });
    const results = await Promise.all([apply(), apply()]);
    expect(results.map((result) => result.status).sort()).toEqual([204, 404]);
    const winner = results.find((result) => result.status === 204);
    if (!winner) throw new Error('Expected exactly one winner');
    const me = await get('/me').set('Cookie', cookieFrom(winner)).expect(200);
    expect(me.body.memberships).toHaveLength(1);
    expect(me.body.memberships[0].roles).toHaveLength(1);
    expect(
      (await auditRows()).filter(({ action }) => action === 'invitation.accepted'),
    ).toHaveLength(1);
  });

  it('logs mail failures generically and keeps credentials out of logs and audit rows', async () => {
    const user = await createUser();
    const invitation = await createInvitation('logs@clinik.test');
    cookieFrom(
      await post(invitation.path + '/accept')
        .send({ fullName, password })
        .expect(204),
    );
    sendMail.mockRejectedValueOnce(new Error(`SMTP detail ${newPassword}`));
    await post('/password/forgot').send({ email: user.email }).expect(202);
    await vi.waitFor(() =>
      expect(output.join('')).toContain('An authentication email could not be sent.'),
    );
    const recorded = JSON.stringify(await auditRows()) + output.join('');
    for (const secret of exposedSecrets) {
      expect(recorded.includes(secret)).toBe(false);
    }
  });
});
