import { rolePermissions, type Permission } from '@clinik/shared';
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
    return scope === 'O' || (scope === 'B' && branchId !== null && branchId === assignedBranch);
  });
}
