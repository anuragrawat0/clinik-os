import { HttpException, Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DATABASE, DatabaseConnection } from '../../core/db/database.module';
import {
  organizationMembers,
  organizations,
  staffRoleAssignments,
  users,
} from '../../core/db/schema/m1a';
import { withTenantTransaction } from '../../core/db/transaction-context';
import type { MeResponseDto } from './auth.dto';

@Injectable()
export class AuthProfileService {
  constructor(@Inject(DATABASE) private readonly database: DatabaseConnection) {}

  async getActiveEmail(userId: string): Promise<string | undefined> {
    const [user] = await this.database.db
      .select({ email: users.email })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.status, 'active')));
    return user?.email;
  }

  async get(userId: string): Promise<MeResponseDto> {
    return withTenantTransaction(this.database.db, { orgId: '', userId }, async (tx) => {
      const [user] = await tx
        .select({
          id: users.id,
          email: users.email,
          fullName: users.fullName,
          isPlatformAdmin: users.isPlatformAdmin,
          emailVerifiedAt: users.emailVerifiedAt,
        })
        .from(users)
        .where(and(eq(users.id, userId), eq(users.status, 'active')));
      if (!user) throw new HttpException({ code: 'UNAUTHENTICATED' }, 401);

      const rows = await tx
        .select({
          organizationId: organizationMembers.organizationId,
          organizationName: organizations.name,
          status: organizationMembers.status,
          organizationStatus: organizations.status,
          role: staffRoleAssignments.role,
          branchId: staffRoleAssignments.branchId,
        })
        .from(organizationMembers)
        .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
        .leftJoin(
          staffRoleAssignments,
          and(
            eq(staffRoleAssignments.organizationId, organizationMembers.organizationId),
            eq(staffRoleAssignments.userId, organizationMembers.userId),
          ),
        )
        .where(eq(organizationMembers.userId, userId))
        .orderBy(
          organizations.name,
          organizations.id,
          staffRoleAssignments.role,
          staffRoleAssignments.branchId,
        );

      const memberships = new Map<string, MeResponseDto['memberships'][number]>();
      for (const { role, branchId, ...membershipFields } of rows) {
        const membership = memberships.get(membershipFields.organizationId) ?? {
          ...membershipFields,
          roles: [],
        };
        if (role !== null) membership.roles.push({ role, branchId });
        memberships.set(membership.organizationId, membership);
      }
      return { user, memberships: [...memberships.values()], patientProfiles: [] };
    });
  }
}
