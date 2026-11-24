import { canGrant } from '@clinik/shared';
import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { DrizzleQueryError, and, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { coversBranch, forbidden } from '../../core/access/access';
import { AuditWriter } from '../../core/audit';
import { CLOCK, type Clock } from '../../core/clock/clock';
import { DATABASE, DatabaseConnection } from '../../core/db/database.module';
import {
  branches,
  invitations,
  organizationMembers,
  organizations,
  sessions,
  staffRoleAssignments,
  users,
} from '../../core/db/schema/m1a';
import { withTenantTransaction, type TenantTransaction } from '../../core/db/transaction-context';
import { parseInput } from '../../core/errors/http-validation';
import { cursorPage, cursorTimestamp, readCursor } from '../../core/pagination/cursor';
import type { TenantOperation } from '../../core/tenancy-context/request-transaction';
import {
  PasswordService,
  SessionNotFoundError,
  SessionService,
  TokenService,
  type RequestMeta,
} from '../identity/core';
import { AuthMailer } from '../notifications/auth-mailer';
import { acceptInvitationInput, type InvitationPreviewDto } from './invitation.dto';
import {
  OrganizationService,
  isUniqueViolation,
  lockOrganization,
  recordMutation,
  type OrganizationActor,
} from './organization.service';
import type {
  InvitationDeliveryDto,
  InvitationListQuery,
  InvitationPageDto,
  StaffAssignment,
} from './tenancy.dto';

const invitationLink = z.tuple([z.guid(), z.string().regex(/^[A-Za-z0-9_-]{43}$/)]);
const invitationCursorId = z.guid();
const invitationTtlMs = 7 * 24 * 60 * 60 * 1000;

interface IssuedInvitation {
  id: string;
  expiresAt: Date;
  email: string;
  fullName?: string;
  token: string;
}

function unavailable(): never {
  throw new HttpException({ code: 'NOT_FOUND' }, HttpStatus.NOT_FOUND);
}

function unauthenticated(): never {
  throw new HttpException({ code: 'UNAUTHENTICATED' }, HttpStatus.UNAUTHORIZED);
}

function parseLink(token: string): [string, string] {
  const parsed = invitationLink.safeParse(token.split('.'));
  if (!parsed.success) unavailable();
  return parsed.data;
}

@Injectable()
export class InvitationService {
  constructor(
    @Inject(DATABASE) private readonly database: DatabaseConnection,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(AuditWriter) private readonly audit: AuditWriter,
    @Inject(AuthMailer) private readonly mailer: AuthMailer,
    @Inject(OrganizationService) private readonly organization: OrganizationService,
  ) {}

  async list(
    actor: TenantOperation,
    { status, cursor, limit }: InvitationListQuery,
  ): Promise<InvitationPageDto> {
    const now = this.clock.now();
    const since = readCursor(cursor, invitationCursorId);
    const coveredBranches = actor.roles.flatMap(({ branchId }) =>
      branchId !== null && coversBranch(actor, 'member.list', branchId) ? [branchId] : [],
    );
    const rows = await actor.tx
      .select({
        id: invitations.id,
        email: invitations.email,
        role: invitations.role,
        branchId: invitations.branchId,
        expiresAt: invitations.expiresAt,
        invitedBy: invitations.invitedBy,
        cursorAt: cursorTimestamp(invitations.createdAt),
        acceptedAt: invitations.acceptedAt,
        revokedAt: invitations.revokedAt,
      })
      .from(invitations)
      .where(
        and(
          eq(invitations.organizationId, actor.orgId),
          coversBranch(actor, 'member.list', null)
            ? undefined
            : inArray(invitations.branchId, coveredBranches),
          status === 'pending'
            ? and(
                isNull(invitations.acceptedAt),
                isNull(invitations.revokedAt),
                gt(invitations.expiresAt, now),
              )
            : undefined,
          since
            ? sql`(${invitations.createdAt} < ${since.at}::timestamptz OR
                (${invitations.createdAt} = ${since.at}::timestamptz AND ${invitations.id} > ${since.id}::uuid))`
            : undefined,
        ),
      )
      .orderBy(desc(invitations.createdAt), invitations.id)
      .limit(limit + 1);
    const page = cursorPage(rows, limit);
    return {
      nextCursor: page.nextCursor,
      items: page.items.map(({ acceptedAt, revokedAt, cursorAt, ...row }) => ({
        ...row,
        createdAt: new Date(cursorAt),
        status: acceptedAt
          ? 'accepted'
          : revokedAt
            ? 'revoked'
            : row.expiresAt <= now
              ? 'expired'
              : 'pending',
      })),
    };
  }

  async issueStaff(
    actor: TenantOperation,
    input: StaffAssignment & { email: string },
    meta: RequestMeta,
  ) {
    const { tx, orgId } = actor;
    if (input.branchId !== null) await this.organization.getBranch(actor, input.branchId);
    if (!canGrant(actor.roles, input.role, input.branchId)) forbidden();
    const locked = await this.organization.lockForMember(actor, 'member.manage');
    if (!canGrant(locked.roles, input.role, input.branchId)) forbidden();
    const branch =
      input.branchId === null
        ? null
        : await this.organization.getBranch(locked, input.branchId, true);
    if (branch && branch.status !== 'active')
      throw new HttpException({ code: 'BRANCH_INACTIVE' }, 422);

    const invitedUser = await this.findUser(tx, input.email);
    if (invitedUser?.id === actor.userId)
      throw new HttpException({ code: 'SELF_GRANT_FORBIDDEN' }, 403);
    const branchMatch =
      input.branchId === null
        ? isNull(staffRoleAssignments.branchId)
        : eq(staffRoleAssignments.branchId, input.branchId);
    if (invitedUser) {
      const [assignment] = await tx
        .select({ id: staffRoleAssignments.id })
        .from(staffRoleAssignments)
        .innerJoin(
          organizationMembers,
          and(
            eq(staffRoleAssignments.organizationId, organizationMembers.organizationId),
            eq(staffRoleAssignments.userId, organizationMembers.userId),
          ),
        )
        .where(
          and(
            eq(staffRoleAssignments.organizationId, orgId),
            eq(staffRoleAssignments.userId, invitedUser.id),
            eq(staffRoleAssignments.role, input.role),
            branchMatch,
            eq(organizationMembers.status, 'active'),
          ),
        );
      if (assignment) throw new HttpException({ code: 'ALREADY_HAS_ROLE' }, 409);
    }

    const now = this.clock.now();
    // The partial unique index also covers expired invitations until they are revoked.
    await tx
      .update(invitations)
      .set({ revokedAt: now })
      .where(
        and(
          eq(invitations.organizationId, orgId),
          eq(invitations.email, input.email),
          eq(invitations.role, input.role),
          input.branchId === null
            ? isNull(invitations.branchId)
            : eq(invitations.branchId, input.branchId),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          lte(invitations.expiresAt, now),
        ),
      );
    return this.insertInvitation(actor, input, now, meta);
  }

  async issueOwner(
    actor: OrganizationActor,
    input: { email: string; fullName?: string },
    meta: RequestMeta,
  ) {
    const { tx, orgId } = actor;
    await lockOrganization(tx, orgId);
    const [owner] = await tx
      .select({ id: staffRoleAssignments.id })
      .from(staffRoleAssignments)
      .where(
        and(
          eq(staffRoleAssignments.organizationId, orgId),
          eq(staffRoleAssignments.role, 'org_owner'),
        ),
      );
    if (owner) throw new HttpException({ code: 'OWNER_EXISTS' }, 409);
    if ((await this.findUser(tx, input.email))?.id === actor.userId) {
      throw new HttpException({ code: 'SELF_GRANT_FORBIDDEN' }, 403);
    }

    const now = this.clock.now();
    await tx
      .update(invitations)
      .set({ revokedAt: now })
      .where(
        and(
          eq(invitations.organizationId, orgId),
          eq(invitations.role, 'org_owner'),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      );
    return this.insertInvitation(actor, { ...input, role: 'org_owner', branchId: null }, now, meta);
  }

  private async insertInvitation(
    actor: OrganizationActor,
    { email, fullName, role, branchId }: StaffAssignment & { email: string; fullName?: string },
    now: Date,
    meta: RequestMeta,
  ): Promise<IssuedInvitation> {
    const token = this.tokens.generate();
    const expiresAt = new Date(now.getTime() + invitationTtlMs);
    const [row] = await actor.tx
      .insert(invitations)
      .values({
        organizationId: actor.orgId,
        email,
        role,
        branchId,
        tokenHash: token.hash,
        invitedBy: actor.userId,
        expiresAt,
      })
      .returning({ id: invitations.id })
      .catch((error: unknown) => {
        if (isUniqueViolation(error, 'invitations_pending_uq'))
          throw new HttpException({ code: 'INVITATION_PENDING' }, 409);
        throw error;
      });
    await recordMutation(this.audit, actor, meta, {
      action: 'invitation.created',
      resourceType: 'invitation',
      resourceId: row.id,
      changedFields: ['email', 'role', 'branchId', 'expiresAt'],
    });
    return { id: row.id, expiresAt, email, fullName, token: `${actor.orgId}.${token.raw}` };
  }

  async deliver({
    id,
    expiresAt,
    email,
    fullName,
    token,
  }: IssuedInvitation): Promise<InvitationDeliveryDto> {
    return {
      id,
      expiresAt,
      emailDelivery: await this.mailer.sendInvitation(email, fullName, token),
    };
  }

  async revoke(actor: TenantOperation, id: string, meta: RequestMeta): Promise<void> {
    const pending = (now: Date) =>
      and(
        eq(invitations.organizationId, actor.orgId),
        eq(invitations.id, id),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
        gt(invitations.expiresAt, now),
      );
    const [invitation] = await actor.tx
      .select({ branchId: invitations.branchId })
      .from(invitations)
      .where(pending(this.clock.now()));
    if (!invitation) unavailable();
    if (!coversBranch(actor, 'member.manage', invitation.branchId)) forbidden();
    const locked = await this.organization.lockForMember(actor, 'member.manage');
    if (!coversBranch(locked, 'member.manage', invitation.branchId)) forbidden();
    const now = this.clock.now();
    const [revoked] = await actor.tx
      .update(invitations)
      .set({ revokedAt: now })
      .where(pending(now))
      .returning({ id: invitations.id });
    if (!revoked) unavailable();
    await recordMutation(this.audit, actor, meta, {
      action: 'invitation.revoked',
      resourceType: 'invitation',
      resourceId: id,
      changedFields: ['revokedAt'],
    });
  }

  private async findInvitation(
    tx: TenantTransaction,
    orgId: string,
    rawToken: string,
    lock: boolean,
  ) {
    const query = tx
      .select({
        invitation: invitations,
        organizationName: organizations.name,
        branchName: branches.name,
      })
      .from(invitations)
      .innerJoin(organizations, eq(organizations.id, invitations.organizationId))
      .leftJoin(
        branches,
        and(
          eq(branches.organizationId, invitations.organizationId),
          eq(branches.id, invitations.branchId),
        ),
      )
      .where(
        and(
          eq(invitations.organizationId, orgId),
          eq(invitations.tokenHash, this.tokens.hash(rawToken)),
          eq(organizations.status, 'active'),
          or(isNull(invitations.branchId), eq(branches.status, 'active')),
        ),
      );
    const [row] = await (lock ? query.for('no key update', { of: invitations }) : query);
    if (
      !row ||
      row.invitation.acceptedAt ||
      row.invitation.revokedAt ||
      row.invitation.expiresAt <= this.clock.now()
    )
      unavailable();
    return row;
  }

  async preview(token: string): Promise<InvitationPreviewDto> {
    const [orgId, rawToken] = parseLink(token);
    return withTenantTransaction(this.database.db, { orgId }, async (tx) => {
      const { invitation, organizationName, branchName } = await this.findInvitation(
        tx,
        orgId,
        rawToken,
        false,
      );
      return { organizationName, role: invitation.role, branchName, email: invitation.email };
    });
  }

  private async findUser(tx: TenantTransaction, email: string) {
    const [user] = await tx
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(eq(users.email, email));
    return user;
  }

  async accept(
    token: string,
    body: unknown,
    cookie: string | undefined,
    meta: RequestMeta,
  ): Promise<string> {
    const [orgId, rawToken] = parseLink(token);
    return withTenantTransaction(this.database.db, { orgId }, async (tx) => {
      // A public request must prove it has a live invitation before it can take the org lock.
      await this.findInvitation(tx, orgId, rawToken, false);
      const org = await lockOrganization(tx, orgId);
      if (org.status !== 'active') unavailable();
      const { invitation } = await this.findInvitation(tx, orgId, rawToken, true);
      if (invitation.branchId !== null) {
        const branch = await this.organization.getBranch({ tx, orgId }, invitation.branchId, true);
        if (branch.status !== 'active') unavailable();
      }
      const { fullName, password } = parseInput(acceptInvitationInput, body ?? {});
      let existing = await this.findUser(tx, invitation.email);
      let newUserId: string | undefined;
      if (!existing) {
        if (fullName === undefined || password === undefined) {
          throw new HttpException({ code: 'INVALID_REQUEST' }, HttpStatus.UNPROCESSABLE_ENTITY);
        }
        const policy = this.passwords.checkPolicy(password, { email: invitation.email, fullName });
        if (policy !== 'ok')
          throw new HttpException({ code: policy }, HttpStatus.UNPROCESSABLE_ENTITY);

        const [inserted] = await tx
          .insert(users)
          .values({
            email: invitation.email,
            fullName,
            passwordHash: await this.passwords.hash(password),
            status: 'active',
            emailVerifiedAt: this.clock.now(),
          })
          .onConflictDoNothing({ target: users.email })
          .returning({ id: users.id });
        newUserId = inserted?.id;
        if (!newUserId) existing = await this.findUser(tx, invitation.email);
      }

      let userId: string;
      let sessionToken: string;
      if (newUserId) {
        userId = newUserId;
        sessionToken = (await this.sessions.create(userId, meta, tx)).rawToken;
      } else {
        if (existing?.status !== 'active' || !cookie || cookie.length > 256) unauthenticated();
        userId = existing.id;
        const now = this.clock.now();
        const [presented] = await tx
          .select({ id: sessions.id })
          .from(sessions)
          .where(
            and(
              eq(sessions.userId, userId),
              eq(sessions.tokenHash, this.tokens.hash(cookie)),
              isNull(sessions.revokedAt),
              gt(sessions.idleExpiresAt, now),
              gt(sessions.absoluteExpiresAt, now),
            ),
          );
        if (!presented) unauthenticated();
        try {
          sessionToken = await this.sessions.rotate(presented.id, tx);
          // Serialize with password reset and status changes. A reset may already hold the
          // user row while waiting for this session row, so fail immediately on a locked user.
          const [active] = await tx
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.id, userId), eq(users.status, 'active')))
            .for('no key update', { noWait: true });
          if (!active) unauthenticated();
        } catch (error) {
          if (error instanceof SessionNotFoundError) unauthenticated();
          if (
            error instanceof DrizzleQueryError &&
            error.cause &&
            'code' in error.cause &&
            error.cause.code === '55P03'
          )
            unauthenticated();
          throw error;
        }
      }

      const membership = and(
        eq(organizationMembers.organizationId, orgId),
        eq(organizationMembers.userId, userId),
      );
      const [reactivated] = await tx
        .update(organizationMembers)
        .set({ status: 'active' })
        .where(and(membership, eq(organizationMembers.status, 'suspended')))
        .returning({ userId: organizationMembers.userId });
      if (reactivated) {
        const assignments = and(
          eq(staffRoleAssignments.organizationId, orgId),
          eq(staffRoleAssignments.userId, userId),
        );
        const [owner] = await tx
          .select({ id: staffRoleAssignments.id })
          .from(staffRoleAssignments)
          .where(and(assignments, eq(staffRoleAssignments.role, 'org_owner')));
        if (owner) unavailable();
        await tx.delete(staffRoleAssignments).where(assignments);
      }
      await tx
        .insert(organizationMembers)
        .values({ organizationId: orgId, userId })
        .onConflictDoNothing();
      const [assignment] = await tx
        .insert(staffRoleAssignments)
        .values({
          organizationId: orgId,
          userId,
          role: invitation.role,
          branchId: invitation.branchId,
          createdBy: invitation.invitedBy,
        })
        .onConflictDoNothing()
        .returning({ id: staffRoleAssignments.id });
      if (!assignment) {
        if (invitation.role === 'org_owner') unavailable();
        const [matching] = await tx
          .select({ id: staffRoleAssignments.id })
          .from(staffRoleAssignments)
          .where(
            and(
              eq(staffRoleAssignments.organizationId, orgId),
              eq(staffRoleAssignments.userId, userId),
              eq(staffRoleAssignments.role, invitation.role),
              invitation.branchId === null
                ? isNull(staffRoleAssignments.branchId)
                : eq(staffRoleAssignments.branchId, invitation.branchId),
            ),
          );
        if (!matching) unavailable();
      }

      const acceptedAt = this.clock.now();
      if (invitation.expiresAt <= acceptedAt) unavailable();
      await tx
        .update(invitations)
        .set({ acceptedAt })
        .where(and(eq(invitations.organizationId, orgId), eq(invitations.id, invitation.id)));
      await this.audit.record(
        {
          action: 'invitation.accepted',
          outcome: 'success',
          actorUserId: userId,
          organizationId: orgId,
          resourceType: 'invitation',
          resourceId: invitation.id,
          changedFields: ['acceptedAt', 'membership', 'roles'],
          ...meta,
        },
        tx,
      );
      return sessionToken;
    });
  }
}
