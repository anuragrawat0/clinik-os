import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { DrizzleQueryError, and, eq, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { AuditWriter } from '../../core/audit';
import { CLOCK, type Clock } from '../../core/clock/clock';
import { DATABASE, DatabaseConnection } from '../../core/db/database.module';
import {
  branches,
  invitations,
  organizationMembers,
  organizations,
  staffRoleAssignments,
  users,
} from '../../core/db/schema/m1a';
import { withTenantTransaction, type TenantTransaction } from '../../core/db/transaction-context';
import { parseInput } from '../../core/errors/http-validation';
import {
  PasswordService,
  SessionNotFoundError,
  SessionService,
  TokenService,
  type RequestMeta,
} from '../identity/core';
import { acceptInvitationInput, type InvitationPreviewDto } from './invitation.dto';

const invitationLink = z.tuple([z.guid(), z.string().regex(/^[A-Za-z0-9_-]{43}$/)]);

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
  ) {}

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
    const [row] = await (lock ? query.for('update', { of: invitations }) : query);
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
    // The public route has no SessionGuard. Resolve the optional cookie before taking DB locks.
    const presented = cookie ? await this.sessions.validate(cookie) : undefined;
    return withTenantTransaction(this.database.db, { orgId }, async (tx) => {
      const { invitation } = await this.findInvitation(tx, orgId, rawToken, true);
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
        if (cookie)
          await this.sessions.revokeByRawToken(cookie, { reason: 'login_replaced', meta }, tx);
        sessionToken = (await this.sessions.create(userId, meta, tx)).rawToken;
      } else {
        if (
          existing?.status !== 'active' ||
          presented?.status !== 'valid' ||
          presented.context.userId !== existing.id
        )
          unauthenticated();
        userId = existing.id;
        try {
          sessionToken = await this.sessions.rotate(presented.context.sessionId, tx);
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
      await tx.update(invitations).set({ acceptedAt }).where(eq(invitations.id, invitation.id));
      await this.audit.record(
        {
          action: 'invitation.accepted',
          outcome: 'success',
          actorUserId: userId,
          organizationId: orgId,
          resourceType: 'invitation',
          resourceId: invitation.id,
          ...meta,
        },
        tx,
      );
      return sessionToken;
    });
  }
}
