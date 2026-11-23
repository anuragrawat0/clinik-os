import { canGrant, isStaffRole, type StaffRole } from '@clinik/shared';
import { HttpException, Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { coversBranch, forbidden } from '../../core/access/access';
import { AuditWriter } from '../../core/audit';
import { CLOCK, type Clock } from '../../core/clock/clock';
import {
  organizationMembers,
  sessions,
  staffRoleAssignments,
  users,
} from '../../core/db/schema/m1a';
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
const reauthFailureLimit = 5;

function selfGrant(): never {
  throw new HttpException({ code: 'SELF_GRANT_FORBIDDEN' }, 403);
}

@Injectable()
export class MemberService {
  private readonly reauthFailures = new Map<string, { count: number }>();
  private readonly pendingReauthDenials = new Map<string, Promise<void>>();

  constructor(
    @Inject(AuditWriter) private readonly audit: AuditWriter,
    @Inject(OrganizationService) private readonly organization: OrganizationService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(CLOCK) private readonly clock: Clock,
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
    const orgWide = coversBranch(actor, 'member.list', null);
    for (const { role, branchId, ...fields } of rows) {
      if (!orgWide && (!role || !coversBranch(actor, 'member.list', branchId))) continue;
      const member = members.get(fields.userId) ?? { ...fields, roles: [] };
      if (role && isStaffRole(role)) member.roles.push({ role, branchId });
      members.set(member.userId, member);
    }
    return [...members.values()];
  }

  async replaceRoles(
    actor: TenantOperation,
    userId: string,
    roles: StaffAssignment[],
    meta: RequestMeta,
  ): Promise<void> {
    if (userId === actor.userId) selfGrant();
    const locked = await this.organization.lockForMember(actor, 'member.manage');
    const { orgId, tx } = locked;
    const oldRoles = await this.organization.activeMemberRoles(locked, userId);
    const oldKeys = new Set(oldRoles.map(roleKey));
    const newKeys = new Set(roles.map(roleKey));
    const added = roles.filter((role) => !oldKeys.has(roleKey(role)));
    const removed = oldRoles.filter((role) => !newKeys.has(roleKey(role)));
    for (const { role, branchId } of added) {
      const branch =
        branchId === null ? null : await this.organization.getBranch(locked, branchId, true);
      if (role === 'org_owner' || !canGrant(locked.roles, role, branchId)) forbidden();
      if (branch && branch.status !== 'active')
        throw new HttpException({ code: 'BRANCH_INACTIVE' }, 422);
    }
    for (const { role, branchId } of removed) {
      if (role === 'org_owner' || !canGrant(locked.roles, role, branchId)) forbidden();
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
    if (userId === actor.userId) forbidden();
    const locked = await this.organization.lockForMember(actor, 'member.manage');
    const { orgId, tx } = locked;
    const target = await this.organization.activeMemberRoles(locked, userId);
    if (highestRank(locked.roles) <= highestRank(target)) forbidden();
    if (
      !coversBranch(locked, 'member.manage', null) &&
      (!target.length ||
        target.some(({ branchId }) => !coversBranch(locked, 'member.manage', branchId)))
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
    sessionId: string,
    { newOwnerUserId, currentPassword }: { newOwnerUserId: string; currentPassword: string },
    meta: RequestMeta,
  ): Promise<void> {
    const { orgId, userId, tx } = actor;
    if (newOwnerUserId === userId) selfGrant();
    await this.organization.activeMemberRoles(actor, newOwnerUserId);
    const userQuery = tx
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.status, 'active')));
    const [user] = await userQuery;
    if (!user?.passwordHash || !(await this.passwords.verify(user.passwordHash, currentPassword))) {
      return this.denyOwnershipTransfer(actor, sessionId, meta);
    }

    const locked = await this.organization.lockForMember(actor, 'org.ownership.transfer');
    await this.organization.activeMemberRoles(locked, newOwnerUserId);
    const [currentUser] = await userQuery.for('no key update');
    if (currentUser?.passwordHash !== user.passwordHash)
      throw new HttpException({ code: 'UNAUTHENTICATED' }, 401);
    if ((await this.reauthSessionTimeLeft(actor, sessionId, true)) === null)
      throw new HttpException({ code: 'UNAUTHENTICATED' }, 401);
    const priorFailures = this.reauthFailures.get(sessionId);

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
    actor.afterCommit(async () => {
      if (this.reauthFailures.get(sessionId) === priorFailures)
        this.reauthFailures.delete(sessionId);
    });
  }

  private async reauthSessionTimeLeft(
    { tx, userId }: TenantOperation,
    sessionId: string,
    lock = false,
  ) {
    const query = tx
      .select({
        idleExpiresAt: sessions.idleExpiresAt,
        absoluteExpiresAt: sessions.absoluteExpiresAt,
      })
      .from(sessions)
      .where(
        and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.revokedAt)),
      );
    const [session] = await (lock ? query.for('no key update') : query);
    const now = this.clock.now();
    if (!session || session.idleExpiresAt <= now || session.absoluteExpiresAt <= now) return null;
    return session.absoluteExpiresAt.getTime() - now.getTime();
  }

  private async denyOwnershipTransfer(
    actor: TenantOperation,
    sessionId: string,
    meta: RequestMeta,
  ): Promise<never> {
    // Serialize denials in memory because revocation takes the row lock in its own transaction.
    const previous = this.pendingReauthDenials.get(sessionId);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pendingReauthDenials.set(sessionId, current);
    try {
      await previous;
      const remainingMs = await this.reauthSessionTimeLeft(actor, sessionId);
      await this.audit.record({
        ...meta,
        action: 'org.ownership_transfer.denied',
        outcome: 'denied',
        organizationId: actor.orgId,
        actorUserId: actor.userId,
        resourceType: 'organization',
        resourceId: actor.orgId,
      });
      if (remainingMs === null) {
        this.reauthFailures.delete(sessionId);
        throw new HttpException({ code: 'UNAUTHENTICATED' }, 401);
      }
      const prior = this.reauthFailures.get(sessionId);
      const count = (prior?.count ?? 0) + 1;
      if (count >= reauthFailureLimit) {
        await this.sessions.revoke(sessionId, {
          userId: actor.userId,
          actorUserId: actor.userId,
          reason: 'reauth_failed',
          meta,
        });
        this.reauthFailures.delete(sessionId);
        throw new HttpException({ code: 'UNAUTHENTICATED' }, 401);
      }
      this.reauthFailures.set(sessionId, { count });
      if (!prior) setTimeout(() => this.reauthFailures.delete(sessionId), remainingMs).unref();
      throw new HttpException({ code: 'INVALID_PASSWORD' }, 422);
    } finally {
      if (this.pendingReauthDenials.get(sessionId) === current)
        this.pendingReauthDenials.delete(sessionId);
      release();
    }
  }
}
