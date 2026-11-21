import type { DatabaseConnection } from '../../../core/db/database.module';
import type { TenantTransaction } from '../../../core/db/transaction-context';

export type Tx = TenantTransaction;

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

export interface SessionRecord {
  id: string;
  userId: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

export interface SessionContext {
  userId: string;
  sessionId: string;
  isPlatformAdmin: boolean;
}

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  isPlatformAdmin: boolean;
  emailVerifiedAt: Date | null;
}

export type PasswordPolicyError =
  'PASSWORD_TOO_SHORT' | 'PASSWORD_TOO_LONG' | 'PASSWORD_TOO_COMMON' | 'PASSWORD_CONTAINS_EMAIL';
export type PasswordPolicyResult = 'ok' | PasswordPolicyError;

export type AuthTokenPurpose = 'password_reset' | 'email_verify';

/** Runs `fn` inside the caller's transaction, or opens a new one. identity tables are not RLS'd. */
export async function inTransaction<T>(
  database: DatabaseConnection,
  tx: Tx | undefined,
  fn: (executor: Tx) => Promise<T>,
): Promise<T> {
  return tx ? fn(tx) : database.db.transaction(fn);
}
