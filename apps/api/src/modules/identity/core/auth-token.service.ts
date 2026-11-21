import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { CLOCK, type Clock } from '../../../core/clock/clock';
import { DATABASE, DatabaseConnection } from '../../../core/db/database.module';
import { authTokens } from '../../../core/db/schema/m1a';
import { RESET_TOKEN_TTL_MS, VERIFY_TOKEN_TTL_MS } from './identity.constants';
import { TokenService } from './token.service';
import { inTransaction, type AuthTokenPurpose, type Tx } from './types';

const DEFAULT_TTL_MS: Readonly<Record<AuthTokenPurpose, number>> = {
  password_reset: RESET_TOKEN_TTL_MS,
  email_verify: VERIFY_TOKEN_TTL_MS,
};

@Injectable()
export class AuthTokenService {
  constructor(
    @Inject(DATABASE) private readonly database: DatabaseConnection,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(TokenService) private readonly tokens: TokenService,
  ) {}

  /**
   * Issues a single-use token and consumes every earlier unconsumed token of the same purpose for
   * the user. Only the sha256 is stored; the raw value is returned once.
   */
  async issue(
    userId: string,
    purpose: AuthTokenPurpose,
    ttlMs: number = DEFAULT_TTL_MS[purpose],
    tx?: Tx,
  ): Promise<string> {
    const now = this.clock.now();
    return inTransaction(this.database, tx, async (executor) => {
      await executor
        .update(authTokens)
        .set({ consumedAt: now })
        .where(
          and(
            eq(authTokens.userId, userId),
            eq(authTokens.purpose, purpose),
            isNull(authTokens.consumedAt),
          ),
        );
      const token = this.tokens.generate();
      await executor.insert(authTokens).values({
        userId,
        purpose,
        tokenHash: token.hash,
        createdAt: now,
        expiresAt: new Date(now.getTime() + ttlMs),
      });
      return token.raw;
    });
  }

  /** The user a currently valid token belongs to, without consuming it. */
  async peek(raw: string, purpose: AuthTokenPurpose): Promise<string | null> {
    if (raw.length === 0 || raw.length > 256) return null;
    const now = this.clock.now();
    const hash = this.tokens.hash(raw);
    return this.database.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ userId: authTokens.userId })
        .from(authTokens)
        .where(
          and(
            eq(authTokens.tokenHash, hash),
            eq(authTokens.purpose, purpose),
            isNull(authTokens.consumedAt),
            gt(authTokens.expiresAt, now),
          ),
        )
        .limit(1);
      return row?.userId ?? null;
    });
  }

  /** Atomic single use: of N concurrent callers exactly one receives the user id. */
  async consume(raw: string, purpose: AuthTokenPurpose, tx?: Tx): Promise<string | null> {
    if (raw.length === 0 || raw.length > 256) return null;
    const now = this.clock.now();
    const hash = this.tokens.hash(raw);
    return inTransaction(this.database, tx, async (executor) => {
      const [row] = await executor
        .update(authTokens)
        .set({ consumedAt: now })
        .where(
          and(
            eq(authTokens.tokenHash, hash),
            eq(authTokens.purpose, purpose),
            isNull(authTokens.consumedAt),
            gt(authTokens.expiresAt, now),
          ),
        )
        .returning({ userId: authTokens.userId });
      return row?.userId ?? null;
    });
  }
}
