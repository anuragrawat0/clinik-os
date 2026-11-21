import { Inject, Injectable } from '@nestjs/common';
import { isIP } from 'node:net';
import { DATABASE, DatabaseConnection } from '../db/database.module';
import { auditLogs } from '../db/schema/m1a';
import { withTenantTransaction, type TenantTransaction } from '../db/transaction-context';

export type AuditOutcome = 'success' | 'denied' | 'error';

export interface AuditEvent {
  /** Dotted lower-case action name, e.g. `auth.login.success`. */
  action: string;
  outcome: AuditOutcome;
  actorUserId?: string | null;
  /** NULL for authentication events. */
  organizationId?: string | null;
  resourceType: string;
  resourceId?: string | null;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  /** Field names and non-secret identifiers only. */
  metadata?: Record<string, unknown>;
  changedFields?: string[];
  actorType?: 'user' | 'system' | 'webhook';
}

const actionPattern = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const forbiddenKey = /pass(word)?|token|cookie|secret|hash|link|authorization|credential/i;
const MAX_DEPTH = 4;
const MAX_USER_AGENT = 512;

/** Replaces the value of any key that could carry a secret. Keys are never secret; values may be. */
export function sanitizeAuditMetadata(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.map((item) => sanitizeAuditMetadata(item, depth + 1));
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const result: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      result[key] = forbiddenKey.test(key) ? '[REDACTED]' : sanitizeAuditMetadata(inner, depth + 1);
    }
    return result;
  }
  return value;
}

@Injectable()
export class AuditWriter {
  constructor(@Inject(DATABASE) private readonly database: DatabaseConnection) {}

  /**
   * Writes one append-only audit row. Pass the caller's transaction so the row commits (or rolls
   * back) together with the change it describes. Without `tx` the row is written in its own short
   * transaction, which is what failure paths use.
   */
  async record(event: AuditEvent, tx?: TenantTransaction): Promise<void> {
    if (!actionPattern.test(event.action)) {
      throw new Error(`Invalid audit action name: ${event.action}`);
    }
    const insert = async (executor: TenantTransaction): Promise<void> => {
      await executor.insert(auditLogs).values({
        organizationId: event.organizationId ?? null,
        actorUserId: event.actorUserId ?? null,
        actorType: event.actorType ?? 'user',
        action: event.action,
        resourceType: event.resourceType,
        resourceId: event.resourceId ?? null,
        outcome: event.outcome,
        requestId: event.requestId ?? null,
        ip: event.ip && isIP(event.ip) !== 0 ? event.ip : null,
        userAgent: event.userAgent ? event.userAgent.slice(0, MAX_USER_AGENT) : null,
        changedFields: event.changedFields ?? null,
        metadata: sanitizeAuditMetadata(event.metadata ?? {}) as Record<string, unknown>,
      });
    };

    if (tx) {
      await insert(tx);
    } else if (event.organizationId) {
      await withTenantTransaction(
        this.database.db,
        { orgId: event.organizationId, userId: event.actorUserId ?? undefined },
        insert,
      );
    } else {
      await this.database.db.transaction(insert);
    }
  }
}
