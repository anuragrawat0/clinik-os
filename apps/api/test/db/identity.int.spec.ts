import { Test, type TestingModule } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditModule } from '../../src/core/audit/audit.module';
import { AuditWriter } from '../../src/core/audit/audit-writer';
import { CLOCK, ClockModule } from '../../src/core/clock/clock';
import { DATABASE, DatabaseConnection, DatabaseModule } from '../../src/core/db/database.module';
import {
  AuthService,
  AuthTokenService,
  IdentityCoreModule,
  IpRateLimiter,
  PasswordService,
  SESSION_ABSOLUTE_TIMEOUT_MS,
  SessionNotFoundError,
  SessionService,
  TokenService,
  type RequestMeta,
  type SessionContext,
} from '../../src/modules/identity/core';
import { FakeClock, HOUR, MINUTE } from '../helpers/fake-clock';
import { type DatabaseHarness, startDatabaseHarness } from './harness';

const PASSWORD = 'correct-horse-battery-staple';
const NEW_PASSWORD = 'a-brand-new-long-passphrase';

let harness: DatabaseHarness;
let moduleRef: TestingModule;
let clock: FakeClock;
let sessions: SessionService;
let auth: AuthService;
let authTokens: AuthTokenService;
let passwords: PasswordService;
let tokens: TokenService;
let audit: AuditWriter;
let limiter: IpRateLimiter;
let connection: DatabaseConnection;
let passwordHash: string;

/** Every secret ever produced or used in this file; scanned at the end. */
const secrets = new Set<string>([PASSWORD, NEW_PASSWORD]);
const stdout: string[] = [];
let ipCounter = 0;
let emailCounter = 0;

function nextIp(): string {
  ipCounter += 1;
  return `10.${Math.floor(ipCounter / 250) % 250}.${ipCounter % 250}.7`;
}

function meta(ip: string = nextIp()): RequestMeta {
  return { ip, userAgent: 'vitest-agent', requestId: `req-${ipCounter}-${Date.now()}` };
}

interface TestUser {
  id: string;
  email: string;
}

async function createUser(
  options: { status?: 'active' | 'pending' | 'disabled'; password?: string | null } = {},
): Promise<TestUser> {
  emailCounter += 1;
  const email = `Person${emailCounter}.Tester@Clinic.Test`;
  const status = options.status ?? 'active';
  const hash = options.password === null ? null : passwordHash;
  const { rows } = await harness.adminPool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, status)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [email, hash, `Test Person ${emailCounter}`, status],
  );
  return { id: rows[0]?.id ?? '', email };
}

async function userRow(id: string): Promise<{
  failed_login_count: number;
  locked_until: Date | null;
  email_verified_at: Date | null;
  password_hash: string;
  last_login_at: Date | null;
}> {
  const { rows } = await harness.adminPool.query(`SELECT * FROM users WHERE id = $1`, [id]);
  return rows[0];
}

async function auditRows(
  where: string,
  params: unknown[],
): Promise<
  {
    action: string;
    outcome: string;
    organization_id: string | null;
    actor_user_id: string | null;
    resource_type: string;
    resource_id: string | null;
    metadata: Record<string, unknown>;
  }[]
> {
  const { rows } = await harness.adminPool.query(
    `SELECT * FROM audit_logs WHERE ${where} ORDER BY id`,
    params,
  );
  return rows;
}

/** Collapses the discriminated validate() result to the context (valid) or null (anything else). */
async function ctxOf(rawToken: string): Promise<SessionContext | null> {
  const result = await sessions.validate(rawToken);
  return result.status === 'valid' ? result.context : null;
}

async function login(user: TestUser, password = PASSWORD, requestMeta: RequestMeta = meta()) {
  return auth.login(user.email, password, requestMeta);
}

beforeAll(async () => {
  const realWrite = process.stdout.write.bind(process.stdout);
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown, ...rest: never[]) => {
    stdout.push(String(chunk));
    return (realWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write);

  harness = await startDatabaseHarness();
  clock = new FakeClock();
  const database = DatabaseModule.forRuntimeRole(
    harness.connectionString('clinic_app'),
    'clinic_app',
    'clinik-identity-test',
  );
  moduleRef = await Test.createTestingModule({
    imports: [
      ClockModule,
      AuditModule.register(database),
      IdentityCoreModule.register({ database, trustedProxyCidrs: [] }),
    ],
  })
    .overrideProvider(CLOCK)
    .useValue(clock)
    .compile();
  await moduleRef.init();
  sessions = moduleRef.get(SessionService);
  auth = moduleRef.get(AuthService);
  authTokens = moduleRef.get(AuthTokenService);
  passwords = moduleRef.get(PasswordService);
  tokens = moduleRef.get(TokenService);
  audit = moduleRef.get(AuditWriter);
  limiter = moduleRef.get(IpRateLimiter);
  connection = moduleRef.get<DatabaseConnection>(DATABASE);
  passwordHash = await passwords.hash(PASSWORD);
}, 180_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await moduleRef?.close();
  await harness?.stop();
});

beforeEach(() => {
  clock.set(new Date());
});

describe('runtime role', () => {
  it('runs the identity services as clinic_app, which owns no tables and cannot bypass RLS', async () => {
    const { rows } = await connection.pool.query(
      `SELECT current_user AS who, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`,
    );
    expect(rows[0]).toMatchObject({ who: 'clinic_app', rolbypassrls: false, rolsuper: false });
  });
});

describe('SessionService', () => {
  it('stores only sha256(token); the raw token never reaches the database', async () => {
    const user = await createUser();
    const { rawToken, session } = await sessions.create(user.id, meta());
    secrets.add(rawToken);

    expect(rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const { rows } = await harness.adminPool.query(`SELECT * FROM sessions WHERE id = $1`, [
      session.id,
    ]);
    const stored = rows[0];
    expect(Buffer.isBuffer(stored.token_hash)).toBe(true);
    expect(stored.token_hash).toEqual(createHash('sha256').update(rawToken).digest());
    expect(JSON.stringify(stored)).not.toContain(rawToken);
    // and nowhere else in the row set either
    const everything = await harness.adminPool.query(`SELECT row_to_json(s) AS j FROM sessions s`);
    expect(JSON.stringify(everything.rows)).not.toContain(rawToken);
    // the exposed record carries no hash
    expect(JSON.stringify(session)).not.toContain('tokenHash');
  });

  it('creates a session that validates to {userId, sessionId, isPlatformAdmin}', async () => {
    const user = await createUser();
    const { rawToken, session } = await sessions.create(user.id, meta());
    secrets.add(rawToken);
    await expect(ctxOf(rawToken)).resolves.toEqual({
      userId: user.id,
      sessionId: session.id,
      isPlatformAdmin: false,
    });
    await expect(ctxOf('totally-unknown-token')).resolves.toBeNull();
    await expect(ctxOf('')).resolves.toBeNull();
  });

  it('reports isPlatformAdmin from the user row', async () => {
    const user = await createUser();
    await harness.adminPool.query(`UPDATE users SET is_platform_admin = true WHERE id = $1`, [
      user.id,
    ]);
    const { rawToken } = await sessions.create(user.id, meta());
    secrets.add(rawToken);
    await expect(ctxOf(rawToken)).resolves.toMatchObject({ isPlatformAdmin: true });
  });

  it('expires after 30 minutes idle, and exposes the staff timeouts', async () => {
    const user = await createUser();
    const { rawToken, session } = await sessions.create(user.id, meta());
    secrets.add(rawToken);
    expect(session.idleExpiresAt.getTime() - session.createdAt.getTime()).toBe(30 * MINUTE);
    expect(session.absoluteExpiresAt.getTime() - session.createdAt.getTime()).toBe(
      SESSION_ABSOLUTE_TIMEOUT_MS,
    );
    expect(SESSION_ABSOLUTE_TIMEOUT_MS).toBe(12 * HOUR);

    clock.advance(29 * MINUTE + 59_000);
    await expect(ctxOf(rawToken)).resolves.not.toBeNull();
    // that validate slid the idle window: another 29 minutes is fine...
    clock.advance(29 * MINUTE);
    await expect(ctxOf(rawToken)).resolves.not.toBeNull();
    // ...but 31 minutes of silence kills it
    clock.advance(31 * MINUTE);
    await expect(ctxOf(rawToken)).resolves.toBeNull();
  });

  it('throttles the sliding refresh to at most one write per 60 seconds', async () => {
    const user = await createUser();
    const { rawToken, session } = await sessions.create(user.id, meta());
    secrets.add(rawToken);
    const read = async () => {
      const { rows } = await harness.adminPool.query(
        `SELECT last_seen_at, idle_expires_at FROM sessions WHERE id = $1`,
        [session.id],
      );
      return rows[0] as { last_seen_at: Date; idle_expires_at: Date };
    };
    const created = session.createdAt.getTime();

    clock.advance(30_000);
    await ctxOf(rawToken);
    expect((await read()).last_seen_at.getTime()).toBe(created); // < 60 s: no write

    clock.advance(29_000);
    await ctxOf(rawToken);
    expect((await read()).last_seen_at.getTime()).toBe(created); // 59 s: still no write

    clock.advance(1_000);
    await ctxOf(rawToken);
    const after = await read();
    expect(after.last_seen_at.getTime()).toBe(created + 60_000); // 60 s: written
    expect(after.idle_expires_at.getTime()).toBe(created + 60_000 + 30 * MINUTE);

    clock.advance(30_000);
    await ctxOf(rawToken);
    expect((await read()).last_seen_at.getTime()).toBe(created + 60_000); // throttled again
  });

  it('expires 12 hours after creation even for a continuously active session', async () => {
    const user = await createUser();
    const { rawToken, session } = await sessions.create(user.id, meta());
    secrets.add(rawToken);

    // active every 20 minutes for 11 h 40 min
    for (let elapsed = 20 * MINUTE; elapsed <= 11 * HOUR + 40 * MINUTE; elapsed += 20 * MINUTE) {
      clock.set(new Date(session.createdAt.getTime() + elapsed));
      await expect(ctxOf(rawToken)).resolves.not.toBeNull();
    }
    const { rows } = await harness.adminPool.query(
      `SELECT idle_expires_at, absolute_expires_at FROM sessions WHERE id = $1`,
      [session.id],
    );
    // the sliding idle window is capped by the absolute deadline
    expect(rows[0].idle_expires_at.getTime()).toBe(rows[0].absolute_expires_at.getTime());

    // 12 h 01 min: the idle window (to 12 h 10) would still allow it; only the absolute limit rejects
    clock.set(new Date(session.createdAt.getTime() + 12 * HOUR + MINUTE));
    await expect(ctxOf(rawToken)).resolves.toBeNull();
  });

  it('rejects revoked sessions immediately', async () => {
    const user = await createUser();
    const { rawToken, session } = await sessions.create(user.id, meta());
    secrets.add(rawToken);
    await expect(sessions.revoke(session.id)).resolves.toBe(true);
    await expect(ctxOf(rawToken)).resolves.toBeNull();
    await expect(sessions.revoke(session.id)).resolves.toBe(false); // already revoked
  });

  it('distinguishes valid, dead and blocked in the validate() result', async () => {
    const user = await createUser();
    const { rawToken, session } = await sessions.create(user.id, meta());
    secrets.add(rawToken);
    await expect(sessions.validate(rawToken)).resolves.toEqual({
      status: 'valid',
      context: { userId: user.id, sessionId: session.id, isPlatformAdmin: false },
    });
    await expect(sessions.validate('unknown-token')).resolves.toEqual({ status: 'dead' });

    await harness.adminPool.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [user.id]);
    await expect(sessions.validate(rawToken)).resolves.toEqual({ status: 'blocked' });
    await harness.adminPool.query(`UPDATE users SET status = 'active' WHERE id = $1`, [user.id]);
    await expect(sessions.validate(rawToken)).resolves.toMatchObject({ status: 'valid' });

    await sessions.revoke(session.id);
    await expect(sessions.validate(rawToken)).resolves.toEqual({ status: 'dead' });
  });

  it('rejects sessions of disabled users, but a lock does NOT affect a live session (D27)', async () => {
    const user = await createUser();
    const { rawToken } = await sessions.create(user.id, meta());
    secrets.add(rawToken);
    await expect(ctxOf(rawToken)).resolves.not.toBeNull();

    await harness.adminPool.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [user.id]);
    await expect(ctxOf(rawToken)).resolves.toBeNull();
    await harness.adminPool.query(`UPDATE users SET status = 'active' WHERE id = $1`, [user.id]);
    await expect(ctxOf(rawToken)).resolves.not.toBeNull();

    await harness.adminPool.query(`UPDATE users SET locked_until = $2 WHERE id = $1`, [
      user.id,
      new Date(clock.now().getTime() + 5 * MINUTE),
    ]);
    await expect(ctxOf(rawToken)).resolves.not.toBeNull();
  });

  it('rotate: old token dead, new token valid, absolute deadline carried over', async () => {
    const user = await createUser();
    const first = await sessions.create(user.id, meta());
    secrets.add(first.rawToken);
    clock.advance(10 * MINUTE);
    const rotated = await sessions.rotate(first.session.id);
    secrets.add(rotated);

    expect(rotated).not.toBe(first.rawToken);
    await expect(ctxOf(first.rawToken)).resolves.toBeNull();
    const context = await ctxOf(rotated);
    expect(context).toMatchObject({ userId: user.id });
    expect(context?.sessionId).not.toBe(first.session.id);

    const active = await sessions.listForUser(user.id);
    expect(active).toHaveLength(1);
    expect(active[0]?.absoluteExpiresAt).toEqual(first.session.absoluteExpiresAt);
    await expect(sessions.rotate(first.session.id)).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it('revokeAllForUser revokes everything, or everything except one session', async () => {
    const user = await createUser();
    const other = await createUser();
    const a = await sessions.create(user.id, meta());
    const b = await sessions.create(user.id, meta());
    const c = await sessions.create(user.id, meta());
    const bystander = await sessions.create(other.id, meta());
    for (const s of [a, b, c, bystander]) secrets.add(s.rawToken);

    await expect(
      sessions.revokeAllForUser(user.id, { exceptSessionId: b.session.id }),
    ).resolves.toBe(2);
    await expect(ctxOf(a.rawToken)).resolves.toBeNull();
    await expect(ctxOf(c.rawToken)).resolves.toBeNull();
    await expect(ctxOf(b.rawToken)).resolves.not.toBeNull();
    await expect(ctxOf(bystander.rawToken)).resolves.not.toBeNull();

    await expect(sessions.revokeAllForUser(user.id)).resolves.toBe(1);
    await expect(ctxOf(b.rawToken)).resolves.toBeNull();
    await expect(ctxOf(bystander.rawToken)).resolves.not.toBeNull();
  });

  it('revoke with userId only matches sessions owned by that user, and audits when given meta', async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const { rawToken, session } = await sessions.create(owner.id, meta());
    secrets.add(rawToken);

    await expect(sessions.revoke(session.id, { userId: stranger.id })).resolves.toBe(false);
    await expect(ctxOf(rawToken)).resolves.not.toBeNull();
    await expect(
      sessions.revoke(session.id, { userId: owner.id, reason: 'user_request', meta: meta() }),
    ).resolves.toBe(true);
    await expect(ctxOf(rawToken)).resolves.toBeNull();

    const rows = await auditRows(`action = 'auth.session.revoked' AND resource_id = $1`, [
      session.id,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: 'success',
      organization_id: null,
      actor_user_id: owner.id,
      resource_type: 'session',
    });
  });

  it('listForUser returns only active sessions, most recently seen first', async () => {
    const user = await createUser();
    const old = await sessions.create(user.id, meta());
    clock.advance(5 * MINUTE);
    const newer = await sessions.create(user.id, meta());
    const dead = await sessions.create(user.id, meta());
    for (const s of [old, newer, dead]) secrets.add(s.rawToken);
    await sessions.revoke(dead.session.id);
    const listed = await sessions.listForUser(user.id);
    expect(listed.map((s) => s.id)).toEqual([newer.session.id, old.session.id]);
  });
});

describe('session revocation audit', () => {
  it('revokeAllForUser writes one session-typed audit row, and none when nothing was revoked', async () => {
    const user = await createUser();
    const a = await sessions.create(user.id, meta());
    const b = await sessions.create(user.id, meta());
    secrets.add(a.rawToken);
    secrets.add(b.rawToken);

    await expect(sessions.revokeAllForUser(user.id, { meta: meta() })).resolves.toBe(2);
    await expect(sessions.revokeAllForUser(user.id, { meta: meta() })).resolves.toBe(0);
    const rows = await auditRows(`action = 'auth.session.revoked' AND metadata->>'userId' = $1`, [
      user.id,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ resource_type: 'session', actor_user_id: user.id });
    expect(rows[0]?.metadata).toMatchObject({ count: 2 });
  });

  it('login_replaced is attributed to the owner of the revoked session, not the logging-in user', async () => {
    const owner = await createUser();
    const other = await createUser();
    const ownerSession = await auth.login(owner.email, PASSWORD, meta());
    if (!ownerSession.ok) throw new Error('login failed');
    secrets.add(ownerSession.rawToken);

    const second = await auth.login(other.email, PASSWORD, meta(), {
      currentRawToken: ownerSession.rawToken,
    });
    if (second.ok) secrets.add(second.rawToken);
    const rows = await auditRows(
      `action = 'auth.session.revoked' AND metadata->>'reason' = 'login_replaced' AND actor_user_id = $1`,
      [owner.id],
    );
    expect(rows).toHaveLength(1);
  });
});

describe('AuthService.login', () => {
  it('succeeds with correct credentials, returns a valid session and the user, audits it', async () => {
    const user = await createUser();
    const requestMeta = meta('10.77.0.1');
    const result = await auth.login(user.email.toLowerCase(), PASSWORD, requestMeta); // citext
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    secrets.add(result.rawToken);
    expect(result.user).toMatchObject({ id: user.id, isPlatformAdmin: false });
    expect(JSON.stringify(result.user)).not.toContain('password');
    await expect(ctxOf(result.rawToken)).resolves.toMatchObject({ userId: user.id });
    expect((await userRow(user.id)).last_login_at).not.toBeNull();

    const rows = await auditRows(`action = 'auth.login.success' AND actor_user_id = $1`, [user.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'success', organization_id: null });
  });

  it('wrong password → INVALID_CREDENTIALS, audited as a failure', async () => {
    const user = await createUser();
    const result = await login(user, 'definitely-the-wrong-password');
    expect(result).toEqual({ ok: false, code: 'INVALID_CREDENTIALS' });
    expect((await userRow(user.id)).failed_login_count).toBe(1);
    const rows = await auditRows(`action = 'auth.login.failure' AND actor_user_id = $1`, [user.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'denied', organization_id: null });
    expect(rows[0]?.metadata).toEqual({ reason: 'bad_password' });
  });

  it('unknown email → the same code, runs dummyVerify, never touches a real verify', async () => {
    const dummy = vi.spyOn(passwords, 'dummyVerify');
    const verify = vi.spyOn(passwords, 'verify');
    const result = await auth.login('nobody.at.all@clinic.test', PASSWORD, meta());
    expect(result).toEqual({ ok: false, code: 'INVALID_CREDENTIALS' });
    expect(dummy).toHaveBeenCalledTimes(1);
    // dummyVerify itself calls verify once; no other verify happened
    expect(verify).toHaveBeenCalledTimes(1);

    const rows = await auditRows(
      `action = 'auth.login.failure' AND actor_user_id IS NULL AND metadata->>'reason' = 'unknown_email'`,
      [],
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    // the attempted email is PII and must not be stored
    expect(JSON.stringify(rows)).not.toContain('nobody.at.all');
  });

  it('disabled user (even with the right password) → the same code, no real verify', async () => {
    const user = await createUser({ status: 'disabled' });
    const dummy = vi.spyOn(passwords, 'dummyVerify');
    const result = await login(user, PASSWORD);
    expect(result).toEqual({ ok: false, code: 'INVALID_CREDENTIALS' });
    expect(dummy).toHaveBeenCalledTimes(1);
    const rows = await auditRows(`action = 'auth.login.failure' AND actor_user_id = $1`, [user.id]);
    expect(rows[0]?.metadata).toEqual({ reason: 'inactive' });
    expect((await userRow(user.id)).failed_login_count).toBe(0);
  });

  it('pending user without a password → the same code', async () => {
    const user = await createUser({ status: 'pending', password: null });
    await expect(login(user, PASSWORD)).resolves.toEqual({
      ok: false,
      code: 'INVALID_CREDENTIALS',
    });
  });

  it('unknown email and wrong password cost about the same (argon2 on both paths)', async () => {
    const user = await createUser();
    await passwords.dummyVerify(); // warm the cached dummy hash
    const time = async (fn: () => Promise<unknown>): Promise<number> => {
      const start = performance.now();
      await fn();
      return performance.now() - start;
    };
    const unknown: number[] = [];
    const wrong: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      unknown.push(await time(() => auth.login('ghost@clinic.test', PASSWORD, meta())));
      // the known user is not locked by 5 failures; reset between rounds to stay under the threshold
      wrong.push(await time(() => login(user, 'wrong-password-wrong')));
    }
    const median = (xs: number[]): number =>
      [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
    const ratio = median(unknown) / median(wrong);
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThan(2.5);
  });

  it('is rate limited per IP: the 21st attempt in a minute returns RATE_LIMITED with retryAfterSec', async () => {
    const user = await createUser();
    const ip = '10.200.0.1';
    for (let i = 0; i < 20; i += 1) {
      const result = await auth.login(user.email, PASSWORD, meta(ip));
      expect(result.ok).toBe(true);
    }
    const blocked = await auth.login(user.email, PASSWORD, meta(ip));
    expect(blocked).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
    expect(blocked.ok === false && blocked.code === 'RATE_LIMITED' && blocked.retryAfterSec).toBe(
      60,
    );
    // another IP is unaffected
    await expect(auth.login(user.email, PASSWORD, meta('10.200.0.2'))).resolves.toMatchObject({
      ok: true,
    });
    clock.advance(61_000);
    await expect(auth.login(user.email, PASSWORD, meta(ip))).resolves.toMatchObject({ ok: true });
  });

  it('session fixation: the session presented at login is revoked and a new token is issued', async () => {
    const user = await createUser();
    const first = await auth.login(user.email, PASSWORD, meta());
    if (!first.ok) throw new Error('login failed');
    secrets.add(first.rawToken);
    await expect(ctxOf(first.rawToken)).resolves.not.toBeNull();

    const second = await auth.login(user.email, PASSWORD, meta(), {
      currentRawToken: first.rawToken,
    });
    if (!second.ok) throw new Error('login failed');
    secrets.add(second.rawToken);
    expect(second.rawToken).not.toBe(first.rawToken);
    await expect(ctxOf(first.rawToken)).resolves.toBeNull();
    await expect(ctxOf(second.rawToken)).resolves.not.toBeNull();
  });

  it('a failed login does not revoke the presented session', async () => {
    const user = await createUser();
    const first = await auth.login(user.email, PASSWORD, meta());
    if (!first.ok) throw new Error('login failed');
    secrets.add(first.rawToken);
    await auth.login(user.email, 'wrong-password-wrong', meta(), {
      currentRawToken: first.rawToken,
    });
    await expect(ctxOf(first.rawToken)).resolves.not.toBeNull();
  });

  it('logout revokes the session immediately and audits it', async () => {
    const user = await createUser();
    const result = await auth.login(user.email, PASSWORD, meta());
    if (!result.ok) throw new Error('login failed');
    secrets.add(result.rawToken);
    await auth.logout(result.rawToken, meta());
    await expect(ctxOf(result.rawToken)).resolves.toBeNull();
    const rows = await auditRows(`action = 'auth.logout' AND actor_user_id = $1`, [user.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'success', organization_id: null });
    // idempotent
    await expect(auth.logout(result.rawToken, meta())).resolves.toBeUndefined();
  });
});

describe('lockout', () => {
  it('locks at 10 failures for 15 minutes, answers generically while locked, unlocks by clock', async () => {
    const user = await createUser();
    for (let i = 1; i <= 9; i += 1) {
      await expect(login(user, 'wrong-password-wrong')).resolves.toEqual({
        ok: false,
        code: 'INVALID_CREDENTIALS',
      });
      expect((await userRow(user.id)).locked_until).toBeNull();
    }
    expect((await userRow(user.id)).failed_login_count).toBe(9);

    await expect(login(user, 'wrong-password-wrong')).resolves.toEqual({
      ok: false,
      code: 'INVALID_CREDENTIALS',
    });
    const locked = await userRow(user.id);
    expect(locked.failed_login_count).toBe(10);
    expect(locked.locked_until?.getTime()).toBe(clock.now().getTime() + 15 * MINUTE);

    const lockoutRows = await auditRows(`action = 'auth.lockout' AND actor_user_id = $1`, [
      user.id,
    ]);
    expect(lockoutRows).toHaveLength(1);

    // correct password while locked: generic code, not counted, no session
    const dummy = vi.spyOn(passwords, 'dummyVerify');
    await expect(login(user, PASSWORD)).resolves.toEqual({
      ok: false,
      code: 'INVALID_CREDENTIALS',
    });
    expect(dummy).toHaveBeenCalledTimes(1);
    expect((await userRow(user.id)).failed_login_count).toBe(10);
    const reasons = await auditRows(`action = 'auth.login.failure' AND actor_user_id = $1`, [
      user.id,
    ]);
    expect(reasons.at(-1)?.metadata).toEqual({ reason: 'locked' });

    clock.advance(14 * MINUTE + 59_000);
    await expect(login(user, PASSWORD)).resolves.toMatchObject({ ok: false });

    clock.advance(2_000); // 15 min + 1 s since the lock
    const unlocked = await login(user, PASSWORD);
    expect(unlocked.ok).toBe(true);
    if (unlocked.ok) secrets.add(unlocked.rawToken);
    const after = await userRow(user.id);
    expect(after.failed_login_count).toBe(0);
    expect(after.locked_until).toBeNull();
  });

  it("D27: 10 failed logins by an attacker leave the victim's live session valid", async () => {
    const user = await createUser();
    const victim = await auth.login(user.email, PASSWORD, meta());
    if (!victim.ok) throw new Error('login failed');
    secrets.add(victim.rawToken);

    for (let i = 0; i < 10; i += 1) await login(user, 'attacker-guess-wrong');
    expect((await userRow(user.id)).locked_until).not.toBeNull();

    // the victim's session still validates, so SessionGuard would neither reject nor clear its cookie
    await expect(sessions.validate(victim.rawToken)).resolves.toMatchObject({ status: 'valid' });
    // while a NEW login (even with the right password) is refused during the lock
    await expect(login(user, PASSWORD)).resolves.toEqual({
      ok: false,
      code: 'INVALID_CREDENTIALS',
    });
  });

  it('resets the counter on success', async () => {
    const user = await createUser();
    for (let i = 0; i < 3; i += 1) await login(user, 'wrong-password-wrong');
    expect((await userRow(user.id)).failed_login_count).toBe(3);
    const ok = await login(user, PASSWORD);
    expect(ok.ok).toBe(true);
    if (ok.ok) secrets.add(ok.rawToken);
    expect((await userRow(user.id)).failed_login_count).toBe(0);
  });

  it('restarts the count (does not re-lock instantly) when a failure follows an expired lock', async () => {
    const user = await createUser();
    for (let i = 0; i < 10; i += 1) await login(user, 'wrong-password-wrong');
    expect((await userRow(user.id)).locked_until).not.toBeNull();
    clock.advance(16 * MINUTE);
    await login(user, 'wrong-password-wrong');
    const row = await userRow(user.id);
    expect(row.failed_login_count).toBe(1);
    expect(row.locked_until).toBeNull();
  });

  it('counts concurrent failures atomically', async () => {
    const user = await createUser();
    await Promise.all(Array.from({ length: 6 }, () => login(user, 'wrong-password-wrong')));
    expect((await userRow(user.id)).failed_login_count).toBe(6);
  });
});

describe('AuthTokenService', () => {
  it('stores only the hash and is single-use', async () => {
    const user = await createUser();
    const raw = await authTokens.issue(user.id, 'password_reset');
    secrets.add(raw);
    const { rows } = await harness.adminPool.query(`SELECT * FROM auth_tokens WHERE user_id = $1`, [
      user.id,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toEqual(tokens.hash(raw));
    expect(JSON.stringify(rows)).not.toContain(raw);

    await expect(authTokens.consume(raw, 'password_reset')).resolves.toBe(user.id);
    await expect(authTokens.consume(raw, 'password_reset')).resolves.toBeNull();
  });

  it('allows exactly one winner among concurrent consumers', async () => {
    const user = await createUser();
    const raw = await authTokens.issue(user.id, 'email_verify');
    secrets.add(raw);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => authTokens.consume(raw, 'email_verify')),
    );
    expect(results.filter((r) => r === user.id)).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(7);
  });

  it('expires: reset after 30 minutes, verify after 24 hours', async () => {
    const user = await createUser();
    const reset = await authTokens.issue(user.id, 'password_reset');
    const verify = await authTokens.issue(user.id, 'email_verify');
    secrets.add(reset);
    secrets.add(verify);

    clock.advance(29 * MINUTE);
    await expect(authTokens.peek(reset, 'password_reset')).resolves.toBe(user.id);
    clock.advance(2 * MINUTE);
    await expect(authTokens.consume(reset, 'password_reset')).resolves.toBeNull();

    clock.advance(22 * HOUR); // 22 h 31 min after issue
    await expect(authTokens.peek(verify, 'email_verify')).resolves.toBe(user.id);
    clock.advance(90 * MINUTE); // 24 h 01 min
    await expect(authTokens.consume(verify, 'email_verify')).resolves.toBeNull();
  });

  it('rejects the wrong purpose without consuming the token', async () => {
    const user = await createUser();
    const raw = await authTokens.issue(user.id, 'password_reset');
    secrets.add(raw);
    await expect(authTokens.consume(raw, 'email_verify')).resolves.toBeNull();
    await expect(authTokens.consume(raw, 'password_reset')).resolves.toBe(user.id);
  });

  it('issuing a new token invalidates the earlier unconsumed token of that purpose only', async () => {
    const user = await createUser();
    const first = await authTokens.issue(user.id, 'password_reset');
    const verify = await authTokens.issue(user.id, 'email_verify');
    const second = await authTokens.issue(user.id, 'password_reset');
    for (const t of [first, verify, second]) secrets.add(t);

    await expect(authTokens.consume(first, 'password_reset')).resolves.toBeNull();
    await expect(authTokens.consume(second, 'password_reset')).resolves.toBe(user.id);
    await expect(authTokens.consume(verify, 'email_verify')).resolves.toBe(user.id);
  });

  it('returns null for garbage input', async () => {
    await expect(authTokens.consume('', 'password_reset')).resolves.toBeNull();
    await expect(authTokens.consume('x'.repeat(500), 'password_reset')).resolves.toBeNull();
    await expect(authTokens.peek('nope', 'email_verify')).resolves.toBeNull();
  });
});

describe('password reset and email verification flows', () => {
  it('requestPasswordReset returns a token for an active user and audits it', async () => {
    const user = await createUser();
    const result = await auth.requestPasswordReset(user.email, meta());
    expect(result).not.toBeNull();
    if (!result) return;
    secrets.add(result.rawToken);
    expect(result.userId).toBe(user.id);
    await expect(authTokens.peek(result.rawToken, 'password_reset')).resolves.toBe(user.id);
    const rows = await auditRows(
      `action = 'auth.password_reset.requested' AND actor_user_id = $1`,
      [user.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'success', organization_id: null });
  });

  it('returns null (no token) for unknown, disabled and pending users', async () => {
    const disabled = await createUser({ status: 'disabled' });
    const pending = await createUser({ status: 'pending', password: null });
    await expect(auth.requestPasswordReset('ghost@clinic.test', meta())).resolves.toBeNull();
    await expect(auth.requestPasswordReset(disabled.email, meta())).resolves.toBeNull();
    await expect(auth.requestPasswordReset(pending.email, meta())).resolves.toBeNull();
    const { rows } = await harness.adminPool.query(
      `SELECT count(*)::int AS n FROM auth_tokens WHERE user_id = ANY($1)`,
      [[disabled.id, pending.id]],
    );
    expect(rows[0].n).toBe(0);
  });

  it('password-forgot is limited to 5 per 15 minutes per IP, indistinguishable from unknown (null)', async () => {
    const user = await createUser();
    const ip = '10.201.0.1';
    for (let i = 0; i < 5; i += 1) {
      const result = await auth.requestPasswordReset(user.email, meta(ip));
      expect(result).not.toBeNull();
      if (result) secrets.add(result.rawToken);
    }
    await expect(auth.requestPasswordReset(user.email, meta(ip))).resolves.toBeNull();
    clock.advance(15 * MINUTE);
    await expect(auth.requestPasswordReset(user.email, meta(ip))).resolves.not.toBeNull();
  });

  it('resetPassword sets the hash, clears lockout and revokes ALL sessions', async () => {
    const user = await createUser();
    const s1 = await auth.login(user.email, PASSWORD, meta());
    const s2 = await auth.login(user.email, PASSWORD, meta());
    if (!s1.ok || !s2.ok) throw new Error('login failed');
    secrets.add(s1.rawToken);
    secrets.add(s2.rawToken);
    await harness.adminPool.query(
      `UPDATE users SET failed_login_count = 10, locked_until = $2 WHERE id = $1`,
      [user.id, new Date(clock.now().getTime() + 10 * MINUTE)],
    );
    const before = (await userRow(user.id)).password_hash;

    const requested = await auth.requestPasswordReset(user.email, meta());
    if (!requested) throw new Error('no token');
    secrets.add(requested.rawToken);
    const result = await auth.resetPassword(requested.rawToken, NEW_PASSWORD, meta());
    expect(result).toEqual({ ok: true, userId: user.id });

    const after = await userRow(user.id);
    expect(after.password_hash).not.toBe(before);
    expect(after.password_hash).toMatch(/^\$argon2id\$/);
    expect(after.failed_login_count).toBe(0);
    expect(after.locked_until).toBeNull();
    await expect(ctxOf(s1.rawToken)).resolves.toBeNull();
    await expect(ctxOf(s2.rawToken)).resolves.toBeNull();
    await expect(login(user, PASSWORD)).resolves.toMatchObject({ ok: false });
    const fresh = await login(user, NEW_PASSWORD);
    expect(fresh.ok).toBe(true);
    if (fresh.ok) secrets.add(fresh.rawToken);

    const rows = await auditRows(
      `action = 'auth.password_reset.completed' AND actor_user_id = $1`,
      [user.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'success', organization_id: null });
  });

  it('the reset token is single-use', async () => {
    const user = await createUser();
    const requested = await auth.requestPasswordReset(user.email, meta());
    if (!requested) throw new Error('no token');
    secrets.add(requested.rawToken);
    await expect(
      auth.resetPassword(requested.rawToken, NEW_PASSWORD, meta()),
    ).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      auth.resetPassword(requested.rawToken, `${NEW_PASSWORD}-2`, meta()),
    ).resolves.toEqual({
      ok: false,
      code: 'INVALID_TOKEN',
    });
  });

  it('an expired, unknown or superseded reset token is INVALID_TOKEN', async () => {
    const user = await createUser();
    const first = await auth.requestPasswordReset(user.email, meta());
    const second = await auth.requestPasswordReset(user.email, meta());
    if (!first || !second) throw new Error('no token');
    secrets.add(first.rawToken);
    secrets.add(second.rawToken);

    await expect(auth.resetPassword(first.rawToken, NEW_PASSWORD, meta())).resolves.toEqual({
      ok: false,
      code: 'INVALID_TOKEN',
    });
    await expect(auth.resetPassword('unknown-token', NEW_PASSWORD, meta())).resolves.toEqual({
      ok: false,
      code: 'INVALID_TOKEN',
    });
    clock.advance(31 * MINUTE);
    await expect(auth.resetPassword(second.rawToken, NEW_PASSWORD, meta())).resolves.toEqual({
      ok: false,
      code: 'INVALID_TOKEN',
    });
  });

  it('a verify-purpose token cannot reset a password', async () => {
    const user = await createUser();
    const verify = await authTokens.issue(user.id, 'email_verify');
    secrets.add(verify);
    await expect(auth.resetPassword(verify, NEW_PASSWORD, meta())).resolves.toEqual({
      ok: false,
      code: 'INVALID_TOKEN',
    });
  });

  it('a password that fails the policy is rejected without burning the token', async () => {
    const user = await createUser();
    const requested = await auth.requestPasswordReset(user.email, meta());
    if (!requested) throw new Error('no token');
    secrets.add(requested.rawToken);
    const before = (await userRow(user.id)).password_hash;

    await expect(auth.resetPassword(requested.rawToken, 'short', meta())).resolves.toEqual({
      ok: false,
      code: 'PASSWORD_TOO_SHORT',
    });
    await expect(auth.resetPassword(requested.rawToken, 'password1234', meta())).resolves.toEqual({
      ok: false,
      code: 'PASSWORD_TOO_COMMON',
    });
    const local = user.email.split('@')[0] ?? '';
    await expect(
      auth.resetPassword(requested.rawToken, `${local}-secret-1`, meta()),
    ).resolves.toEqual({ ok: false, code: 'PASSWORD_CONTAINS_EMAIL' });
    expect((await userRow(user.id)).password_hash).toBe(before);

    await expect(
      auth.resetPassword(requested.rawToken, NEW_PASSWORD, meta()),
    ).resolves.toMatchObject({
      ok: true,
    });
  });

  it('verifyEmail sets email_verified_at, is single-use and audited', async () => {
    const user = await createUser();
    expect((await userRow(user.id)).email_verified_at).toBeNull();
    const raw = await authTokens.issue(user.id, 'email_verify');
    secrets.add(raw);
    await expect(auth.verifyEmail(raw, meta())).resolves.toEqual({ ok: true, userId: user.id });
    const verified = (await userRow(user.id)).email_verified_at;
    expect(verified?.getTime()).toBe(clock.now().getTime());

    await expect(auth.verifyEmail(raw, meta())).resolves.toEqual({
      ok: false,
      code: 'INVALID_TOKEN',
    });
    // the original verification time is not overwritten by a later verification
    clock.advance(HOUR);
    const again = await authTokens.issue(user.id, 'email_verify');
    secrets.add(again);
    await auth.verifyEmail(again, meta());
    expect((await userRow(user.id)).email_verified_at?.getTime()).toBe(verified?.getTime());

    const rows = await auditRows(`action = 'auth.email.verified' AND actor_user_id = $1`, [
      user.id,
    ]);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toMatchObject({ outcome: 'success', organization_id: null });
  });

  it('token-verify is limited to 30 per minute per IP', async () => {
    const ip = '10.202.0.1';
    for (let i = 0; i < 30; i += 1) {
      await expect(auth.verifyEmail('unknown-token', meta(ip))).resolves.toEqual({
        ok: false,
        code: 'INVALID_TOKEN',
      });
    }
    await expect(auth.verifyEmail('unknown-token', meta(ip))).resolves.toEqual({
      ok: false,
      code: 'RATE_LIMITED',
      retryAfterSec: 60,
    });
    await expect(auth.resetPassword('unknown-token', NEW_PASSWORD, meta(ip))).resolves.toEqual({
      ok: false,
      code: 'RATE_LIMITED',
      retryAfterSec: 60,
    });
    expect(limiter.consume('token-verify', ip).allowed).toBe(false);
  });
});

describe('AuditWriter', () => {
  it('writes in the caller transaction: a rolled-back change leaves no audit row', async () => {
    const marker = `rollback-${Date.now()}`;
    await expect(
      connection.db.transaction(async (tx) => {
        await audit.record(
          {
            action: 'auth.logout',
            outcome: 'success',
            resourceType: 'session',
            resourceId: marker,
            requestId: 'rb',
          },
          tx,
        );
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await auditRows(`resource_id = $1`, [marker])).toHaveLength(0);
  });

  it('writes standalone failures in their own transaction', async () => {
    const marker = `standalone-${Date.now()}`;
    await audit.record({
      action: 'auth.login.failure',
      outcome: 'denied',
      resourceType: 'session',
      resourceId: marker,
      requestId: 'sa',
      ip: '10.9.9.9',
      userAgent: 'vitest',
    });
    const rows = await auditRows(`resource_id = $1`, [marker]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.organization_id).toBeNull();
  });

  it('redacts metadata keys that could carry secrets and rejects invalid action names', async () => {
    const marker = `redact-${Date.now()}`;
    await audit.record({
      action: 'auth.login.failure',
      outcome: 'denied',
      resourceType: 'session',
      resourceId: marker,
      metadata: {
        reason: 'bad_password',
        password: 'hunter2-hunter2',
        nested: { sessionToken: 'tok-123', resetLink: 'https://x/reset?t=abc', ok: 1 },
        cookie: '__Host-session=abc',
      },
    });
    const rows = await auditRows(`resource_id = $1`, [marker]);
    expect(rows[0]?.metadata).toEqual({
      reason: 'bad_password',
      password: '[REDACTED]',
      nested: { sessionToken: '[REDACTED]', resetLink: '[REDACTED]', ok: 1 },
      cookie: '[REDACTED]',
    });
    await expect(
      audit.record({ action: 'Not A Valid Action', outcome: 'success', resourceType: 'x' }),
    ).rejects.toThrow(/Invalid audit action/);
  });

  it('tolerates a malformed IP by storing NULL instead of failing the auth flow', async () => {
    const marker = `badip-${Date.now()}`;
    await audit.record({
      action: 'auth.logout',
      outcome: 'success',
      resourceType: 'session',
      resourceId: marker,
      ip: 'not-an-ip',
    });
    expect(await auditRows(`resource_id = $1 AND ip IS NULL`, [marker])).toHaveLength(1);
  });
});

describe('audit coverage and secret hygiene (runs last: scans everything above)', () => {
  const actions = [
    'auth.login.success',
    'auth.login.failure',
    'auth.lockout',
    'auth.logout',
    'auth.session.revoked',
    'auth.password_reset.requested',
    'auth.password_reset.completed',
    'auth.email.verified',
  ];

  it.each(actions)('wrote at least one %s row with a NULL organization', async (action) => {
    const rows = await auditRows(`action = $1`, [action]);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.organization_id === null)).toBe(true);
  });

  it('no audit row, session row, token row or log line contains a raw token or password', async () => {
    const everything = await harness.adminPool.query(
      `SELECT row_to_json(a)::text AS j FROM audit_logs a
       UNION ALL SELECT row_to_json(s)::text FROM sessions s
       UNION ALL SELECT row_to_json(t)::text FROM auth_tokens t
       UNION ALL SELECT row_to_json(u)::text FROM users u`,
    );
    const database = everything.rows.map((row: { j: string }) => row.j).join('\n');
    const logs = stdout.join('');
    expect(secrets.size).toBeGreaterThan(20);
    for (const secret of secrets) {
      expect(database, 'database content').not.toContain(secret);
      expect(logs, 'log output').not.toContain(secret);
    }
  });
});
