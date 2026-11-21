import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, isNull, ne } from 'drizzle-orm';
import { AuditWriter } from '../../../core/audit/audit-writer';
import { CLOCK, type Clock } from '../../../core/clock/clock';
import { DATABASE, DatabaseConnection } from '../../../core/db/database.module';
import { sessions, users } from '../../../core/db/schema/m1a';
import {
  AuthAuditAction,
  SESSION_ABSOLUTE_TIMEOUT_MS,
  SESSION_TOUCH_INTERVAL_MS,
  STAFF_IDLE_TIMEOUT_MS,
} from './identity.constants';
import { TokenService } from './token.service';
import {
  inTransaction,
  type RequestMeta,
  type SessionContext,
  type SessionRecord,
  type Tx,
} from './types';

export class SessionNotFoundError extends Error {
  constructor() {
    super('Session not found, revoked or expired.');
    this.name = 'SessionNotFoundError';
  }
}

export interface RevokeOptions {
  /** Only revoke a session owned by this user (use for "revoke my own session"). */
  userId?: string;
  reason?: string;
  /** When present an `auth.session.revoked` audit row is written in the same transaction. */
  meta?: RequestMeta;
  actorUserId?: string;
}

export interface RevokeAllOptions {
  exceptSessionId?: string;
  reason?: string;
  meta?: RequestMeta;
  actorUserId?: string;
}

/**
 * - `valid`: attach the context.
 * - `dead`: unknown, revoked, idle-expired or absolute-expired; the cookie is useless and may be cleared.
 * - `blocked`: the session itself is fine but the user is not `active` (disabled/pending). Reject, but do
 *   not clear the cookie. Lockout (D27) only blocks NEW logins and never affects live sessions.
 */
export type SessionValidation =
  { status: 'valid'; context: SessionContext } | { status: 'dead' } | { status: 'blocked' };

const DEAD: SessionValidation = { status: 'dead' };

type SessionRow = typeof sessions.$inferSelect;

function toRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.userId,
    ip: row.ip,
    userAgent: row.userAgent,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    idleExpiresAt: row.idleExpiresAt,
    absoluteExpiresAt: row.absoluteExpiresAt,
  };
}

@Injectable()
export class SessionService {
  constructor(
    @Inject(DATABASE) private readonly database: DatabaseConnection,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(AuditWriter) private readonly audit: AuditWriter,
  ) {}

  private idleExpiry(now: Date, absolute: Date): Date {
    return new Date(Math.min(now.getTime() + STAFF_IDLE_TIMEOUT_MS, absolute.getTime()));
  }

  async create(
    userId: string,
    meta: Pick<RequestMeta, 'ip' | 'userAgent'>,
    tx?: Tx,
  ): Promise<{ rawToken: string; session: SessionRecord }> {
    const now = this.clock.now();
    const absolute = new Date(now.getTime() + SESSION_ABSOLUTE_TIMEOUT_MS);
    return inTransaction(this.database, tx, async (executor) =>
      this.insertSession(executor, userId, meta, now, absolute),
    );
  }

  private async insertSession(
    executor: Tx,
    userId: string,
    meta: Pick<RequestMeta, 'ip' | 'userAgent'>,
    now: Date,
    absolute: Date,
  ): Promise<{ rawToken: string; session: SessionRecord }> {
    const token = this.tokens.generate();
    const [row] = await executor
      .insert(sessions)
      .values({
        userId,
        tokenHash: token.hash,
        ip: meta.ip,
        userAgent: meta.userAgent ? meta.userAgent.slice(0, 512) : null,
        createdAt: now,
        lastSeenAt: now,
        idleExpiresAt: this.idleExpiry(now, absolute),
        absoluteExpiresAt: absolute,
      })
      .returning();
    if (!row) throw new Error('Session insert returned no row.');
    return { rawToken: token.raw, session: toRecord(row) };
  }

  async validate(rawToken: string): Promise<SessionValidation> {
    if (rawToken.length === 0 || rawToken.length > 256) return DEAD;
    const hash = this.tokens.hash(rawToken);
    const now = this.clock.now();

    return this.database.db.transaction(async (tx): Promise<SessionValidation> => {
      const [found] = await tx
        .select({
          session: sessions,
          status: users.status,
          isPlatformAdmin: users.isPlatformAdmin,
        })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(eq(sessions.tokenHash, hash))
        .limit(1);
      if (!found) return DEAD;

      const { session } = found;
      if (session.revokedAt !== null) return DEAD;
      if (session.idleExpiresAt <= now) return DEAD;
      if (session.absoluteExpiresAt <= now) return DEAD;
      if (found.status !== 'active') return { status: 'blocked' };

      if (now.getTime() - session.lastSeenAt.getTime() >= SESSION_TOUCH_INTERVAL_MS) {
        await tx
          .update(sessions)
          .set({
            lastSeenAt: now,
            idleExpiresAt: this.idleExpiry(now, session.absoluteExpiresAt),
          })
          .where(and(eq(sessions.id, session.id), isNull(sessions.revokedAt)));
      }
      return {
        status: 'valid',
        context: {
          userId: session.userId,
          sessionId: session.id,
          isPlatformAdmin: found.isPlatformAdmin,
        },
      };
    });
  }

  /**
   * New token for the same user and device on privilege change. The old row is revoked and the
   * absolute lifetime is carried over, so rotation never extends a session.
   */
  async rotate(sessionId: string, tx?: Tx): Promise<string> {
    const now = this.clock.now();
    return inTransaction(this.database, tx, async (executor) => {
      const [old] = await executor
        .select()
        .from(sessions)
        .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)))
        .for('update');
      if (!old || old.absoluteExpiresAt <= now || old.idleExpiresAt <= now) {
        throw new SessionNotFoundError();
      }
      await executor.update(sessions).set({ revokedAt: now }).where(eq(sessions.id, old.id));
      const created = await this.insertSession(
        executor,
        old.userId,
        { ip: old.ip, userAgent: old.userAgent },
        now,
        old.absoluteExpiresAt,
      );
      return created.rawToken;
    });
  }

  async revoke(sessionId: string, options: RevokeOptions = {}, tx?: Tx): Promise<boolean> {
    const now = this.clock.now();
    return inTransaction(this.database, tx, async (executor) => {
      const conditions = [eq(sessions.id, sessionId), isNull(sessions.revokedAt)];
      if (options.userId) conditions.push(eq(sessions.userId, options.userId));
      const revoked = await executor
        .update(sessions)
        .set({ revokedAt: now })
        .where(and(...conditions))
        .returning({ id: sessions.id, userId: sessions.userId });
      const row = revoked[0];
      if (!row) return false;
      if (options.meta) {
        await this.audit.record(
          {
            action: AuthAuditAction.SessionRevoked,
            outcome: 'success',
            actorUserId: options.actorUserId ?? row.userId,
            resourceType: 'session',
            resourceId: row.id,
            requestId: options.meta.requestId,
            ip: options.meta.ip,
            userAgent: options.meta.userAgent,
            metadata: { reason: options.reason ?? 'revoked' },
          },
          executor,
        );
      }
      return true;
    });
  }

  async revokeAllForUser(userId: string, options: RevokeAllOptions = {}, tx?: Tx): Promise<number> {
    const now = this.clock.now();
    return inTransaction(this.database, tx, async (executor) => {
      const conditions = [eq(sessions.userId, userId), isNull(sessions.revokedAt)];
      if (options.exceptSessionId) conditions.push(ne(sessions.id, options.exceptSessionId));
      const revoked = await executor
        .update(sessions)
        .set({ revokedAt: now })
        .where(and(...conditions))
        .returning({ id: sessions.id });
      if (options.meta && revoked.length > 0) {
        await this.audit.record(
          {
            action: AuthAuditAction.SessionRevoked,
            outcome: 'success',
            actorUserId: options.actorUserId ?? userId,
            resourceType: 'session',
            resourceId: null,
            requestId: options.meta.requestId,
            ip: options.meta.ip,
            userAgent: options.meta.userAgent,
            metadata: {
              reason: options.reason ?? 'revoked_all',
              userId,
              count: revoked.length,
            },
          },
          executor,
        );
      }
      return revoked.length;
    });
  }

  /** Active (not revoked, not expired) sessions, most recently seen first. */
  async listForUser(userId: string): Promise<SessionRecord[]> {
    const now = this.clock.now();
    return this.database.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(sessions)
        .where(
          and(
            eq(sessions.userId, userId),
            isNull(sessions.revokedAt),
            gt(sessions.idleExpiresAt, now),
            gt(sessions.absoluteExpiresAt, now),
          ),
        )
        .orderBy(desc(sessions.lastSeenAt));
      return rows.map(toRecord);
    });
  }

  /** Revokes the session that owns `rawToken`, if any. Returns the owner and session ids. */
  async revokeByRawToken(
    rawToken: string,
    options: Omit<RevokeOptions, 'userId'> = {},
    tx?: Tx,
  ): Promise<{ sessionId: string; userId: string } | null> {
    const hash = this.tokens.hash(rawToken);
    return inTransaction(this.database, tx, async (executor) => {
      const [row] = await executor
        .select({ id: sessions.id, userId: sessions.userId })
        .from(sessions)
        .where(and(eq(sessions.tokenHash, hash), isNull(sessions.revokedAt)))
        .limit(1);
      if (!row) return null;
      const revoked = await this.revoke(row.id, options, executor);
      return revoked ? { sessionId: row.id, userId: row.userId } : null;
    });
  }
}
