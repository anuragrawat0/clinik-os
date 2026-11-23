import { canGrant, isStaffRole, type StaffRole } from '@clinik/shared';
import { HttpException, Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { coversBranch, forbidden, notFound } from '../../core/access/access';
import { AuditWriter } from '../../core/audit';
import { organizationMembers, staffRoleAssignments, users } from '../../core/db/schema/m1a';
import type { TenantOperation } from '../../core/tenancy-context/request-transaction';
import { PasswordService, SessionService, type RequestMeta } from '../identity/core';
import { OrganizationService, recordMutation } from './organization.service';
import { roleKey, type MemberDto, type StaffAssignment } from './tenancy.dto';

const roleRanks: Record<StaffRole, number> = {
  org_owner: 4,
  org_admin: 3,
  branch_manager: 2,
  doctor: 1,
  receptionist: 1,
};
const highestRank = (roles: readonly StaffAssignment[]) =>
  Math.max(0, ...roles.map(({ role }) => roleRanks[role]));

function selfGrant(): never {
  throw new HttpException({ code: 'SELF_GRANT_FORBIDDEN' }, 403);
}

@Injectable()
export class MemberService {
  constructor(
    @Inject(AuditWriter) private readonly audit: AuditWriter,
    @Inject(OrganizationService) private readonly organization: OrganizationService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  async list(actor: TenantOperation): Promise<MemberDto[]> {
    const { tx, orgId } = actor;
    const rows = await tx
      .select({
        userId: organizationMembers.userId,
        joinedAt: organizationMembers.joinedAt,
        email: users.email,
        fullName: users.fullName,
        role: staffRoleAssignments.role,
        branchId: staffRoleAssignments.branchId,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .leftJoin(
        staffRoleAssignments,
        and(
          eq(staffRoleAssignments.organizationId, organizationMembers.organizationId),
          eq(staffRoleAssignments.userId, organizationMembers.userId),
        ),
      )
      .where(
        and(
          eq(organizationMembers.organizationId, orgId),
          eq(organizationMembers.status, 'active'),
        ),
      )
      .orderBy(users.fullName, users.id, staffRoleAssignments.role, staffRoleAssignments.branchId);
    const members = new Map<string, MemberDto>();
    for (const { role, branchId, ...fields } of rows) {
      const member = members.get(fields.userId) ?? { ...fields, roles: [] };
      if (role && isStaffRole(role)) member.roles.push({ role, branchId });
      members.set(member.userId, member);
    }
    if (coversBranch(actor, 'member.list', null)) return [...members.values()];
    return [...members.values()].filter((member) =>
      member.roles.some(({ branchId }) => coversBranch(actor, 'member.list', branchId ?? null)),
    );
  }

  private async activeRoles({ tx, orgId }: TenantOperation, userId: string) {
    const [member] = await tx
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, orgId),
          eq(organizationMembers.userId, userId),
          eq(organizationMembers.status, 'active'),
        ),
      );
    if (!member) notFound();
    const rows = await tx
      .select({
        id: staffRoleAssignments.id,
        role: staffRoleAssignments.role,
        branchId: staffRoleAssignments.branchId,
      })
      .from(staffRoleAssignments)
      .where(
        and(
          eq(staffRoleAssignments.organizationId, orgId),
          eq(staffRoleAssignments.userId, userId),
        ),
      );
    return rows.flatMap(({ id, role, branchId }) =>
      isStaffRole(role) ? [{ id, role, branchId }] : [],
    );
  }

  async replaceRoles(
    actor: TenantOperation,
    userId: string,
    roles: StaffAssignment[],
    meta: RequestMeta,
  ): Promise<void> {
    const { orgId, tx } = actor;
    if (userId === actor.userId) selfGrant();
    const oldRoles = await this.activeRoles(actor, userId);
    const oldKeys = new Set(oldRoles.map(roleKey));
    const newKeys = new Set(roles.map(roleKey));
    const added = roles.filter((role) => !oldKeys.has(roleKey(role)));
    const removed = oldRoles.filter((role) => !newKeys.has(roleKey(role)));
    for (const { role, branchId } of [...added, ...removed]) {
      if (branchId !== null) await this.organization.getBranch(actor, branchId);
      if (role === 'org_owner' || !canGrant(actor.roles, role, branchId)) forbidden();
    }
    if (removed.length)
      await tx.delete(staffRoleAssignments).where(
        and(
          eq(staffRoleAssignments.organizationId, orgId),
          eq(staffRoleAssignments.userId, userId),
          inArray(
            staffRoleAssignments.id,
            removed.map(({ id }) => id),
          ),
        ),
      );
    if (added.length)
      await tx.insert(staffRoleAssignments).values(
        added.map((role) => ({
          ...role,
          organizationId: orgId,
          userId,
          createdBy: actor.userId,
        })),
      );
    await recordMutation(this.audit, actor, meta, {
      action: 'member.roles_replaced',
      resourceType: 'organization_member',
      resourceId: userId,
      changedFields: added.length || removed.length ? ['roles'] : [],
    });
  }

  async remove(actor: TenantOperation, userId: string, meta: RequestMeta): Promise<void> {
    const { orgId, tx } = actor;
    if (userId === actor.userId) forbidden();
    const target = await this.activeRoles(actor, userId);
    if (highestRank(actor.roles) <= highestRank(target)) forbidden();
    if (
      !coversBranch(actor, 'member.manage', null) &&
      (!target.length ||
        target.some(({ branchId }) => !coversBranch(actor, 'member.manage', branchId)))
    )
      forbidden();

    await tx
      .update(organizationMembers)
      .set({ status: 'suspended' })
      .where(
        and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.userId, userId)),
      );
    await tx
      .delete(staffRoleAssignments)
      .where(
        and(
          eq(staffRoleAssignments.organizationId, orgId),
          eq(staffRoleAssignments.userId, userId),
        ),
      );
    await this.sessions.revokeAllForUser(userId, {}, tx);
    await recordMutation(this.audit, actor, meta, {
      action: 'member.removed',
      resourceType: 'organization_member',
      resourceId: userId,
      changedFields: ['status', 'roles', 'sessions'],
    });
  }

  async transferOwnership(
    actor: TenantOperation,
    { newOwnerUserId, currentPassword }: { newOwnerUserId: string; currentPassword: string },
    meta: RequestMeta,
  ): Promise<void> {
    const { orgId, userId, tx } = actor;
    if (newOwnerUserId === userId) selfGrant();
    await this.activeRoles(actor, newOwnerUserId);
    const [user] = await tx
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId))
      .for('no key update');
    if (!user?.passwordHash || !(await this.passwords.verify(user.passwordHash, currentPassword)))
      throw new HttpException({ code: 'INVALID_PASSWORD' }, 422);

    const assignment = (assignee: string, role: StaffRole) =>
      and(
        eq(staffRoleAssignments.organizationId, orgId),
        eq(staffRoleAssignments.userId, assignee),
        eq(staffRoleAssignments.role, role),
      );
    await tx.delete(staffRoleAssignments).where(assignment(userId, 'org_owner'));
    await tx.insert(staffRoleAssignments).values({
      organizationId: orgId,
      userId: newOwnerUserId,
      role: 'org_owner',
      createdBy: userId,
    });
    await tx.delete(staffRoleAssignments).where(assignment(newOwnerUserId, 'org_admin'));
    await tx
      .insert(staffRoleAssignments)
      .values({
        organizationId: orgId,
        userId,
        role: 'org_admin',
        createdBy: userId,
      })
      .onConflictDoNothing();
    await recordMutation(this.audit, actor, meta, {
      action: 'organization.ownership_transferred',
      resourceType: 'organization',
      resourceId: orgId,
      changedFields: ['roles'],
    });
  }
}
