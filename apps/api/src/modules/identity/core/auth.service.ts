import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { AuditWriter } from '../../../core/audit/audit-writer';
import { CLOCK, type Clock } from '../../../core/clock/clock';
import { DATABASE, DatabaseConnection } from '../../../core/db/database.module';
import { users } from '../../../core/db/schema/m1a';
import { AuthTokenService } from './auth-token.service';
import { IpRateLimiter } from './ip-rate-limiter';
import { AuthAuditAction } from './identity.constants';
import { LockoutService } from './lockout.service';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';
import type { AuthUser, PasswordPolicyError, RequestMeta } from './types';

const MAX_EMAIL_LENGTH = 254;
const MAX_LOGIN_PASSWORD_LENGTH = 1024;

export type LoginResult =
  | { ok: true; rawToken: string; user: AuthUser }
  | { ok: false; code: 'INVALID_CREDENTIALS' }
  | { ok: false; code: 'RATE_LIMITED'; retryAfterSec: number };

export type ResetPasswordResult =
  | { ok: true; userId: string }
  | { ok: false; code: 'INVALID_TOKEN' | 'RATE_LIMITED' | PasswordPolicyError };

export type VerifyEmailResult =
  { ok: true; userId: string } | { ok: false; code: 'INVALID_TOKEN' | 'RATE_LIMITED' };

type UserRow = typeof users.$inferSelect;

type FailureReason = 'unknown_email' | 'bad_password' | 'locked' | 'inactive';

function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    fullName: row.fullName,
    isPlatformAdmin: row.isPlatformAdmin,
    emailVerifiedAt: row.emailVerifiedAt,
  };
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(DATABASE) private readonly database: DatabaseConnection,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(LockoutService) private readonly lockout: LockoutService,
    @Inject(AuthTokenService) private readonly authTokens: AuthTokenService,
    @Inject(IpRateLimiter) private readonly limiter: IpRateLimiter,
    @Inject(AuditWriter) private readonly audit: AuditWriter,
  ) {}

  private async findUserByEmail(email: string): Promise<UserRow | null> {
    const candidate = email.trim();
    if (candidate.length === 0 || candidate.length > MAX_EMAIL_LENGTH) return null;
    return this.database.db.transaction(async (tx) => {
      const [row] = await tx.select().from(users).where(eq(users.email, candidate)).limit(1);
      return row ?? null;
    });
  }

  private async findUserById(id: string): Promise<UserRow | null> {
    return this.database.db.transaction(async (tx) => {
      const [row] = await tx.select().from(users).where(eq(users.id, id)).limit(1);
      return row ?? null;
    });
  }

  /** Same code for every cause; the reason is kept only in the audit row. */
  private async failLogin(
    reason: FailureReason,
    userId: string | null,
    meta: RequestMeta,
    countFailure: boolean,
  ): Promise<LoginResult> {
    const now = this.clock.now();
    await this.database.db.transaction(async (tx) => {
      let lockedNow = false;
      if (countFailure && userId) {
        lockedNow = (await this.lockout.recordFailure(userId, now, tx)).lockedNow;
      }
      await this.audit.record(
        {
          action: AuthAuditAction.LoginFailure,
          outcome: 'denied',
          actorUserId: userId,
          resourceType: 'session',
          requestId: meta.requestId,
          ip: meta.ip,
          userAgent: meta.userAgent,
          metadata: { reason },
        },
        tx,
      );
      if (lockedNow && userId) {
        await this.audit.record(
          {
            action: AuthAuditAction.Lockout,
            outcome: 'denied',
            actorUserId: userId,
            resourceType: 'user',
            resourceId: userId,
            requestId: meta.requestId,
            ip: meta.ip,
            userAgent: meta.userAgent,
            metadata: { reason: 'too_many_failures' },
          },
          tx,
        );
      }
    });
    return { ok: false, code: 'INVALID_CREDENTIALS' };
  }

  async login(
    email: string,
    password: string,
    meta: RequestMeta,
    options: { currentRawToken?: string } = {},
  ): Promise<LoginResult> {
    const limit = this.limiter.consume('login', meta.ip);
    if (!limit.allowed) {
      return { ok: false, code: 'RATE_LIMITED', retryAfterSec: limit.retryAfterSec };
    }

    const user = await this.findUserByEmail(email);
    const now = this.clock.now();
    const passwordUsable = password.length > 0 && password.length <= MAX_LOGIN_PASSWORD_LENGTH;

    if (!user || user.passwordHash === null) {
      await this.passwords.dummyVerify();
      return this.failLogin('unknown_email', null, meta, false);
    }
    if (user.status !== 'active') {
      await this.passwords.dummyVerify();
      return this.failLogin('inactive', user.id, meta, false);
    }
    if (this.lockout.isLocked(user.lockedUntil, now)) {
      await this.passwords.dummyVerify();
      return this.failLogin('locked', user.id, meta, false);
    }
    if (!passwordUsable) {
      await this.passwords.dummyVerify();
      return this.failLogin('bad_password', user.id, meta, true);
    }
    if (!(await this.passwords.verify(user.passwordHash, password))) {
      return this.failLogin('bad_password', user.id, meta, true);
    }

    const created = await this.database.db.transaction(async (tx) => {
      if (options.currentRawToken) {
        await this.sessions.revokeByRawToken(
          options.currentRawToken,
          { reason: 'login_replaced', meta },
          tx,
        );
      }
      await this.lockout.recordSuccess(user.id, now, tx);
      const result = await this.sessions.create(user.id, meta, tx);
      await this.audit.record(
        {
          action: AuthAuditAction.LoginSuccess,
          outcome: 'success',
          actorUserId: user.id,
          resourceType: 'session',
          resourceId: result.session.id,
          requestId: meta.requestId,
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
      return result;
    });
    return { ok: true, rawToken: created.rawToken, user: toAuthUser(user) };
  }

  async logout(rawToken: string, meta: RequestMeta): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      const revoked = await this.sessions.revokeByRawToken(rawToken, { reason: 'logout' }, tx);
      if (!revoked) return;
      await this.audit.record(
        {
          action: AuthAuditAction.Logout,
          outcome: 'success',
          actorUserId: revoked.userId,
          resourceType: 'session',
          resourceId: revoked.sessionId,
          requestId: meta.requestId,
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
    });
  }

  /**
   * Returns the raw token to e-mail, or null. Unknown, inactive and rate-limited all give null, so
   * the caller answers generically and cannot reveal which.
   */
  async requestPasswordReset(
    email: string,
    meta: RequestMeta,
  ): Promise<{ userId: string; rawToken: string } | null> {
    const base = {
      action: AuthAuditAction.PasswordResetRequested,
      resourceType: 'user',
      requestId: meta.requestId,
      ip: meta.ip,
      userAgent: meta.userAgent,
    };
    if (!this.limiter.consume('password-forgot', meta.ip).allowed) {
      await this.audit.record({
        ...base,
        outcome: 'denied',
        metadata: { reason: 'rate_limited' },
      });
      return null;
    }
    const user = await this.findUserByEmail(email);
    if (!user || user.status !== 'active') {
      await this.audit.record({
        ...base,
        outcome: 'denied',
        metadata: { reason: 'unknown_or_inactive' },
      });
      return null;
    }
    return this.database.db.transaction(async (tx) => {
      const rawToken = await this.authTokens.issue(user.id, 'password_reset', undefined, tx);
      await this.audit.record(
        { ...base, outcome: 'success', actorUserId: user.id, resourceId: user.id },
        tx,
      );
      return { userId: user.id, rawToken };
    });
  }

  async resetPassword(
    rawResetToken: string,
    newPassword: string,
    meta: RequestMeta,
  ): Promise<ResetPasswordResult> {
    const base = {
      action: AuthAuditAction.PasswordResetCompleted,
      resourceType: 'user',
      requestId: meta.requestId,
      ip: meta.ip,
      userAgent: meta.userAgent,
    };
    if (!this.limiter.consume('token-verify', meta.ip).allowed) {
      return { ok: false, code: 'RATE_LIMITED' };
    }
    const invalid = async (): Promise<ResetPasswordResult> => {
      await this.audit.record({
        ...base,
        outcome: 'denied',
        metadata: { reason: 'invalid_token' },
      });
      return { ok: false, code: 'INVALID_TOKEN' };
    };

    const userId = await this.authTokens.peek(rawResetToken, 'password_reset');
    const user = userId ? await this.findUserById(userId) : null;
    if (!user || user.status !== 'active') return invalid();

    // Policy first: a rejected password must not burn the single-use token.
    const policy = this.passwords.checkPolicy(newPassword, {
      email: user.email,
      fullName: user.fullName,
    });
    if (policy !== 'ok') return { ok: false, code: policy };

    const passwordHash = await this.passwords.hash(newPassword);
    const completed = await this.database.db.transaction(async (tx) => {
      const consumedFor = await this.authTokens.consume(rawResetToken, 'password_reset', tx);
      if (consumedFor !== user.id) return false;
      await tx.update(users).set({ passwordHash }).where(eq(users.id, user.id));
      await this.lockout.clear(user.id, tx);
      await this.sessions.revokeAllForUser(
        user.id,
        { reason: 'password_reset', meta, actorUserId: user.id },
        tx,
      );
      await this.audit.record(
        { ...base, outcome: 'success', actorUserId: user.id, resourceId: user.id },
        tx,
      );
      return true;
    });
    return completed ? { ok: true, userId: user.id } : invalid();
  }

  async verifyEmail(rawVerifyToken: string, meta: RequestMeta): Promise<VerifyEmailResult> {
    const base = {
      action: AuthAuditAction.EmailVerified,
      resourceType: 'user',
      requestId: meta.requestId,
      ip: meta.ip,
      userAgent: meta.userAgent,
    };
    if (!this.limiter.consume('token-verify', meta.ip).allowed) {
      return { ok: false, code: 'RATE_LIMITED' };
    }
    const now = this.clock.now();
    const userId = await this.database.db.transaction(async (tx) => {
      const consumedFor = await this.authTokens.consume(rawVerifyToken, 'email_verify', tx);
      if (!consumedFor) return null;
      await tx
        .update(users)
        .set({
          emailVerifiedAt: sql`COALESCE(${users.emailVerifiedAt}, ${now.toISOString()}::timestamptz)`,
        })
        .where(eq(users.id, consumedFor));
      await this.audit.record(
        { ...base, outcome: 'success', actorUserId: consumedFor, resourceId: consumedFor },
        tx,
      );
      return consumedFor;
    });
    if (!userId) {
      await this.audit.record({
        ...base,
        outcome: 'denied',
        metadata: { reason: 'invalid_token' },
      });
      return { ok: false, code: 'INVALID_TOKEN' };
    }
    return { ok: true, userId };
  }
}
