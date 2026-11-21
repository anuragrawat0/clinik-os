import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { users } from '../../../core/db/schema/m1a';
import { LOCKOUT_DURATION_MS, LOCKOUT_THRESHOLD } from './identity.constants';
import type { Tx } from './types';

export interface FailureOutcome {
  failedCount: number;
  /** True when this very failure tripped the threshold. */
  lockedNow: boolean;
}

/**
 * Per-account lockout. Callers must not call `recordFailure` while the account is currently locked
 * (attempts during a lock are not counted and are reported with the generic failure code).
 */
@Injectable()
export class LockoutService {
  isLocked(lockedUntil: Date | null, now: Date): boolean {
    return lockedUntil !== null && lockedUntil > now;
  }

  /**
   * One atomic UPDATE so concurrent failures cannot lose increments. If an earlier lock has
   * expired the count restarts at 1 instead of re-locking on the next typo.
   */
  async recordFailure(userId: string, now: Date, tx: Tx): Promise<FailureOutcome> {
    const nowIso = now.toISOString();
    const lockUntilIso = new Date(now.getTime() + LOCKOUT_DURATION_MS).toISOString();
    const lockExpired = sql`(${users.lockedUntil} IS NOT NULL AND ${users.lockedUntil} <= ${nowIso}::timestamptz)`;
    const nextCount = sql`(CASE WHEN ${lockExpired} THEN 1 ELSE ${users.failedLoginCount} + 1 END)`;
    const [row] = await tx
      .update(users)
      .set({
        failedLoginCount: nextCount,
        lockedUntil: sql`CASE WHEN ${nextCount} >= ${LOCKOUT_THRESHOLD} THEN ${lockUntilIso}::timestamptz WHEN ${lockExpired} THEN NULL ELSE ${users.lockedUntil} END`,
      })
      .where(eq(users.id, userId))
      .returning({ failedLoginCount: users.failedLoginCount, lockedUntil: users.lockedUntil });
    if (!row) return { failedCount: 0, lockedNow: false };
    return {
      failedCount: row.failedLoginCount,
      lockedNow: row.lockedUntil !== null && row.lockedUntil > now,
    };
  }

  async recordSuccess(userId: string, now: Date, tx: Tx): Promise<void> {
    await tx
      .update(users)
      .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: now })
      .where(eq(users.id, userId));
  }

  async clear(userId: string, tx: Tx): Promise<void> {
    await tx
      .update(users)
      .set({ failedLoginCount: 0, lockedUntil: null })
      .where(eq(users.id, userId));
  }
}
