/** Session lifetimes. Staff only; the 60 min patient idle timeout is deferred to M6. */
export const STAFF_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const SESSION_ABSOLUTE_TIMEOUT_MS = 12 * 60 * 60 * 1000;
/** Sliding-idle writes are throttled to one per session per interval. */
export const SESSION_TOUCH_INTERVAL_MS = 60 * 1000;

export const LOCKOUT_THRESHOLD = 10;
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
export const ARGON2_MEMORY_COST_KIB = 19_456;
export const ARGON2_TIME_COST = 2;
export const ARGON2_PARALLELISM = 1;

/** Assumed TTLs (labelled assumptions in the contract). */
export const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;
export const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export type RateLimitBucket = 'login' | 'password-forgot' | 'token-verify';

export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

/** Assumed defaults, single API instance (D12). */
export const DEFAULT_RATE_LIMITS: Readonly<Record<RateLimitBucket, RateLimitRule>> = {
  login: { limit: 20, windowMs: 60 * 1000 },
  'password-forgot': { limit: 5, windowMs: 15 * 60 * 1000 },
  'token-verify': { limit: 30, windowMs: 60 * 1000 },
};

export const AuthAuditAction = {
  LoginSuccess: 'auth.login.success',
  LoginFailure: 'auth.login.failure',
  Lockout: 'auth.lockout',
  Logout: 'auth.logout',
  SessionRevoked: 'auth.session.revoked',
  PasswordResetRequested: 'auth.password_reset.requested',
  PasswordResetCompleted: 'auth.password_reset.completed',
  EmailVerified: 'auth.email.verified',
} as const;
