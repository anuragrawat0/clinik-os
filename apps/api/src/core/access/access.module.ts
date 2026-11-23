import { isStaffRole, rolePermissions, type Permission } from '@clinik/shared';
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Module,
} from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { and, eq, sql } from 'drizzle-orm';
import type { Response } from 'express';
import { z } from 'zod';
import { database } from '../../app.wiring';
import { DATABASE, DatabaseConnection } from '../db/database.module';
import { organizationMembers, organizations, staffRoleAssignments } from '../db/schema/m1a';
import { withTenantTransaction } from '../db/transaction-context';
import {
  TenantTransactionInterceptor,
  TenantWork,
  type TenantRequest,
} from '../tenancy-context/request-transaction';
import { forbidden, notFound, PLATFORM_ADMIN, REQUIRED_PERMISSION } from './access';

const orgIdInput = z.guid().transform((id) => id.toLowerCase());

@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<boolean>(PLATFORM_ADMIN, [
      context.getHandler(),
      context.getClass(),
    ]);
    const req = context.switchToHttp().getRequest<TenantRequest>();
    if (required && !req.auth?.isPlatformAdmin) notFound();
    return true;
  }
}

@Injectable()
export class TenantGuard implements CanActivate {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const req = http.getRequest<TenantRequest>();
    if (!Object.hasOwn(req.params ?? {}, 'orgId')) return true;
    const parsed = orgIdInput.safeParse(req.params.orgId);
    const userId = req.auth?.userId;
    if (!parsed.success || !userId) notFound();
    const orgId = parsed.data;
    const work = new TenantWork(http.getResponse<Response>(), (publish) =>
      withTenantTransaction(this.connection.db, { orgId: '', userId }, async (tx) => {
        const ownActiveMembership = and(
          eq(organizationMembers.organizationId, orgId),
          eq(organizationMembers.userId, userId),
          eq(organizationMembers.status, 'active'),
        );
        const membershipQuery = tx
          .select({ userId: organizationMembers.userId })
          .from(organizationMembers)
          .where(ownActiveMembership);
        const orgQuery = tx
          .select({ id: organizations.id })
          .from(organizations)
          .where(and(eq(organizations.id, orgId), eq(organizations.status, 'active')));
        const [membership] = await membershipQuery;
        if (!membership) notFound();
        const writes = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
        const [org] = await (writes ? orgQuery.for('update') : orgQuery);
        if (!org) notFound();
        // A removal could have committed while this write waited for the organization lock.
        if (writes && !(await membershipQuery)[0]) notFound();
        const rows = await tx
          .select({ role: staffRoleAssignments.role, branchId: staffRoleAssignments.branchId })
          .from(staffRoleAssignments)
          .where(
            and(
              eq(staffRoleAssignments.organizationId, orgId),
              eq(staffRoleAssignments.userId, userId),
            ),
          );
        const roles = rows.flatMap(({ role, branchId }) =>
          isStaffRole(role) ? [{ role, branchId }] : [],
        );
        await tx.execute(sql`select set_config('app.current_org_id', ${orgId}, true)`);
        return publish({ orgId, roles, userId, tx });
      }),
    );
    const operation = await work.operation;
    req.tenant = { orgId, roles: operation.roles };
    req.tenantOperation = operation;
    req.tenantWork = work;
    return true;
  }
}

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const permission = this.reflector.getAllAndOverride<Permission>(REQUIRED_PERMISSION, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!permission) return true;
    const req = context.switchToHttp().getRequest<TenantRequest>();
    if (req.tenant?.roles.some(({ role }) => rolePermissions[role][permission])) return true;
    if (req.tenantWork) await req.tenantWork.finish(async () => forbidden());
    return forbidden();
  }
}

@Module({
  imports: [database],
  providers: [
    { provide: APP_GUARD, useClass: PlatformAdminGuard },
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantTransactionInterceptor },
  ],
})
export class AccessModule {}
