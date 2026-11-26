import {
  canGrant,
  isStaffRole,
  outranksStaffMember,
  rolePermissions,
  type StaffRole,
} from '@clinik/shared';
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

const reauthFailureLimit = 5;

function selfGrant(): never {
  throw new HttpException({ code: 'SELF_GRANT_FORBIDDEN' }, 403);
}

function canEditOtherRoles(actor: TenantOperation, target: readonly StaffAssignment[]): boolean {
  return (
    outranksStaffMember(actor.roles, target) &&
    target.every(({ branchId }) => coversBranch(actor, 'member.manage', branchId))
  );
}

function canRemoveMember(
  actor: TenantOperation,
  userId: string,
  target: readonly StaffAssignment[],
): boolean {
  return (
    actor.userId !== userId &&
    outranksStaffMember(actor.roles, target) &&
    (coversBranch(actor, 'member.manage', null) ||
      (target.length > 0 &&
        target.every(({ branchId }) => coversBranch(actor, 'member.manage', branchId))))
  );
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
    const members = new Map<
      string,
      Omit<MemberDto, 'roles' | 'canEditRoles' | 'canRemove'> & { roles: StaffAssignment[] }
    >();
    const orgWide = coversBranch(actor, 'member.list', null);
    for (const { role, branchId, ...fields } of rows) {
      const member = members.get(fields.userId) ?? { ...fields, roles: [] };
      if (role && isStaffRole(role)) member.roles.push({ role, branchId });
      members.set(member.userId, member);
    }
    const canManage = actor.roles.some(({ role }) => rolePermissions[role]['member.manage']);
    return [...members.values()].flatMap((member) => {
      const roles = orgWide
        ? member.roles
        : member.roles.filter(
            ({ branchId }) => branchId === null || coversBranch(actor, 'member.list', branchId),
          );
      if (!orgWide && roles.length === 0) return [];
      const canEditRoles =
        Boolean(canManage) &&
        (member.userId === actor.userId
          ? member.roles.length > 1 && member.roles.some(({ role }) => role !== 'org_owner')
          : canEditOtherRoles(actor, member.roles));
      return [
        {
          ...member,
          roles,
          canEditRoles,
          canRemove: canRemoveMember(actor, member.userId, member.roles),
        },
      ];
    });
  }

  async replaceRoles(
    actor: TenantOperation,
    userId: string,
    roles: StaffAssignment[],
    meta: RequestMeta,
  ): Promise<void> {
    const locked = await this.organization.lockForMember(actor, 'member.manage');
    const { orgId, tx } = locked;
    const oldRoles = await this.organization.activeMemberRoles(locked, userId);
    const self = userId === locked.userId;
    if (!self && !canEditOtherRoles(locked, oldRoles)) forbidden();
    if (!self && roles.length === 0) throw new HttpException({ code: 'EMPTY_ROLES' }, 422);
    const oldKeys = new Set(oldRoles.map(roleKey));
    const newKeys = new Set(roles.map(roleKey));
    const added = roles.filter((role) => !oldKeys.has(roleKey(role)));
    const removed = oldRoles.filter((role) => !newKeys.has(roleKey(role)));
    if (self) {
      if (added.length || !removed.length) selfGrant();
      if (removed.some(({ role }) => role === 'org_owner')) forbidden();
      if (!roles.length) throw new HttpException({ code: 'LAST_ROLE' }, 422);
    }
    for (const { role, branchId } of added) {
      const branch =
        branchId === null ? null : await this.organization.getBranch(locked, branchId, true);
      if (role === 'org_owner' || !canGrant(locked.roles, role, branchId)) forbidden();
      if (branch && branch.status !== 'active')
        throw new HttpException({ code: 'BRANCH_INACTIVE' }, 422);
    }
    if (
      !self &&
      removed.some(
        ({ role, branchId }) => role === 'org_owner' || !canGrant(locked.roles, role, branchId),
      )
    )
      forbidden();
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
    await this.audit.record(
      {
        ...meta,
        organizationId: orgId,
        actorUserId: locked.userId,
        action: 'member.roles_replaced',
        outcome: 'success',
        resourceType: 'organization_member',
        resourceId: userId,
        changedFields: added.length || removed.length ? ['roles'] : [],
        metadata: self ? { self: true } : undefined,
      },
      tx,
    );
  }

  async remove(actor: TenantOperation, userId: string, meta: RequestMeta): Promise<void> {
    if (userId === actor.userId) forbidden();
    const locked = await this.organization.lockForMember(actor, 'member.manage');
    const { orgId, tx } = locked;
    const target = await this.organization.activeMemberRoles(locked, userId);
    if (!canRemoveMember(locked, userId, target)) forbidden();

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
