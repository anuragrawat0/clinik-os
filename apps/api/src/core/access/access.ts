import { hasScope, rolePermissions, type Permission } from '@clinik/shared';
import { HttpException, SetMetadata } from '@nestjs/common';
import type { RequestTenant } from '../tenancy-context/request-transaction';

export const REQUIRED_PERMISSION = Symbol('REQUIRED_PERMISSION');
export const PLATFORM_ADMIN = Symbol('PLATFORM_ADMIN');
export const Require = (permission: Permission) => SetMetadata(REQUIRED_PERMISSION, permission);
export const PlatformAdmin = () => SetMetadata(PLATFORM_ADMIN, true);

export function forbidden(): never {
  throw new HttpException({ code: 'FORBIDDEN' }, 403);
}

export function notFound(): never {
  throw new HttpException({ code: 'NOT_FOUND' }, 404);
}

export function coversBranch(
  tenant: RequestTenant,
  permission: Permission,
  branchId: string | null,
): boolean {
  return tenant.roles.some(({ role, branchId: assignedBranch }) => {
    const scope = rolePermissions[role][permission];
    return (
      hasScope(scope, 'O') ||
      (hasScope(scope, 'B') && branchId !== null && branchId === assignedBranch)
    );
  });
}

/** Apply after tenant, permission and role checks. Identifiers must come from trusted lookups. */
export function ownsResource(
  actor: { userId: string; doctorId?: string | null },
  resource: { doctorId?: string | null; patientAccountUserId?: string | null },
): boolean {
  return (
    (resource.doctorId != null && resource.doctorId === actor.doctorId) ||
    (resource.patientAccountUserId != null && resource.patientAccountUserId === actor.userId)
  );
}
