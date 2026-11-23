import { HttpException, Inject, Injectable } from '@nestjs/common';
import { DrizzleQueryError, and, eq, gt, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { coversBranch, forbidden, notFound } from '../../core/access/access';
import { AuditWriter, type AuditEvent } from '../../core/audit';
import { branches, organizations } from '../../core/db/schema/m1a';
import type { TenantTransaction } from '../../core/db/transaction-context';
import type { TenantOperation } from '../../core/tenancy-context/request-transaction';
import type { RequestMeta } from '../identity/core';
import {
  validateTimezone,
  type createBranchInput,
  type updateBranchInput,
  type updateOrganizationInput,
} from './tenancy.dto';

export type OrganizationActor = { orgId: string; userId: string; tx: TenantTransaction };

export function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    error instanceof DrizzleQueryError &&
    !!error.cause &&
    'code' in error.cause &&
    error.cause.code === '23505' &&
    'constraint' in error.cause &&
    error.cause.constraint === constraint
  );
}

export function recordMutation(
  audit: AuditWriter,
  actor: OrganizationActor,
  meta: RequestMeta,
  event: Pick<AuditEvent, 'action' | 'resourceType' | 'resourceId' | 'changedFields'>,
): Promise<void> {
  return audit.record(
    {
      ...event,
      ...meta,
      organizationId: actor.orgId,
      actorUserId: actor.userId,
      outcome: 'success',
    },
    actor.tx,
  );
}

@Injectable()
export class OrganizationService {
  constructor(@Inject(AuditWriter) private readonly audit: AuditWriter) {}

  async list(tx: TenantTransaction, { cursor, limit }: { cursor?: string; limit: number }) {
    const rows = await tx
      .select({ id: organizations.id, name: organizations.name, status: organizations.status })
      .from(organizations)
      .where(cursor ? gt(organizations.id, cursor) : undefined)
      .orderBy(organizations.id)
      .limit(limit + 1);
    const items = rows.slice(0, limit);
    return { items, nextCursor: rows.length > limit ? items[limit - 1].id : null };
  }

  async create(
    tx: TenantTransaction,
    userId: string,
    input: { name: string; slug: string; defaultTimezone: string },
    meta: RequestMeta,
  ) {
    validateTimezone(input.defaultTimezone);
    const [org] = await tx
      .insert(organizations)
      .values(input)
      .returning()
      .catch((error: unknown) => {
        if (isUniqueViolation(error, 'organizations_slug_key'))
          throw new HttpException({ code: 'ORG_SLUG_TAKEN' }, 409);
        throw error;
      });
    await tx.execute(sql`select set_config('app.current_org_id', ${org.id}, true)`);
    await recordMutation(this.audit, { orgId: org.id, userId, tx }, meta, {
      action: 'organization.created',
      resourceType: 'organization',
      resourceId: org.id,
      changedFields: Object.keys(input),
    });
    return org;
  }

  async get(tx: TenantTransaction, orgId: string, lock = false) {
    const query = tx.select().from(organizations).where(eq(organizations.id, orgId));
    const [org] = await (lock ? query.for('update') : query);
    return org ?? notFound();
  }

  async update(
    actor: OrganizationActor,
    input: z.output<typeof updateOrganizationInput> | { status: 'active' | 'suspended' },
    meta: RequestMeta,
  ) {
    if ('defaultTimezone' in input) validateTimezone(input.defaultTimezone);
    const [updated] = await actor.tx
      .update(organizations)
      .set(input)
      .where(eq(organizations.id, actor.orgId))
      .returning();
    if (!updated) notFound();
    const action =
      'status' in input
        ? input.status === 'active'
          ? 'organization.reactivated'
          : 'organization.suspended'
        : 'organization.updated';
    await recordMutation(this.audit, actor, meta, {
      action,
      resourceType: 'organization',
      resourceId: actor.orgId,
      changedFields: Object.keys(input),
    });
    return updated;
  }

  listBranches({ tx, orgId }: TenantOperation) {
    return tx
      .select()
      .from(branches)
      .where(eq(branches.organizationId, orgId))
      .orderBy(branches.code);
  }

  async getBranch({ tx, orgId }: OrganizationActor, branchId: string) {
    const [branch] = await tx
      .select()
      .from(branches)
      .where(and(eq(branches.organizationId, orgId), eq(branches.id, branchId)));
    return branch ?? notFound();
  }

  async createBranch(
    actor: TenantOperation,
    input: z.output<typeof createBranchInput>,
    meta: RequestMeta,
  ) {
    validateTimezone(input.timezone);
    const [branch] = await actor.tx
      .insert(branches)
      .values({ ...input, organizationId: actor.orgId })
      .returning()
      .catch(branchConflict);
    await recordMutation(this.audit, actor, meta, {
      action: 'branch.created',
      resourceType: 'branch',
      resourceId: branch.id,
      changedFields: Object.keys(input),
    });
    return branch;
  }

  async updateBranch(
    actor: TenantOperation,
    branchId: string,
    input: z.output<typeof updateBranchInput>,
    meta: RequestMeta,
  ) {
    await this.getBranch(actor, branchId);
    if (!coversBranch(actor, 'branch.update', branchId)) forbidden();
    if (input.status !== undefined && !coversBranch(actor, 'branch.manage', branchId)) forbidden();
    validateTimezone(input.timezone);
    const [branch] = await actor.tx
      .update(branches)
      .set(input)
      .where(and(eq(branches.organizationId, actor.orgId), eq(branches.id, branchId)))
      .returning()
      .catch(branchConflict);
    await recordMutation(this.audit, actor, meta, {
      action: 'branch.updated',
      resourceType: 'branch',
      resourceId: branch.id,
      changedFields: Object.keys(input),
    });
    return branch;
  }
}

function branchConflict(error: unknown): never {
  if (isUniqueViolation(error, 'branches_organization_id_code_key'))
    throw new HttpException({ code: 'BRANCH_CODE_TAKEN' }, 409);
  throw error;
}
