import {
  canGrant,
  hasScope,
  outranksStaffMember,
  rolePermissions,
  staffRoles,
  type Permission,
  type RoleScope,
  type StaffRole,
} from '@clinik/shared';

const navigation = [
  { path: '', label: 'Dashboard', any: [] },
  { path: '/settings/branches', label: 'Branches', any: ['branch.update', 'branch.manage'] },
  { path: '/settings/members', label: 'Members', any: ['member.list'] },
  { path: '/audit', label: 'Audit log', any: ['audit.read'] },
  { path: '/settings', label: 'Settings', any: ['org.update'] },
] as const satisfies ReadonlyArray<{ path: string; label: string; any: readonly Permission[] }>;

type MemberRole = { role: StaffRole; branchId?: string | null };

export function hasPermission(roles: readonly RoleScope[], permission: Permission): boolean {
  return roles.some(({ role }) => Boolean(rolePermissions[role][permission]));
}

export function organizationNavigation(roles: readonly RoleScope[]) {
  return navigation.filter(
    ({ any }) => any.length === 0 || any.some((p) => hasPermission(roles, p)),
  );
}

export function canManageBranch(
  roles: readonly RoleScope[],
  permission: Permission,
  branchId: string | null,
): boolean {
  return roles.some(({ role, branchId: assigned }) => {
    const scope = rolePermissions[role][permission];
    return (
      hasScope(scope, 'O') || (branchId !== null && assigned === branchId && hasScope(scope, 'B'))
    );
  });
}

export function roleOptions(
  actor: readonly RoleScope[],
  branches: readonly { id: string; status: string }[],
) {
  return staffRoles.flatMap((role) => {
    if (role === 'org_owner') return [];
    const scopes =
      role === 'org_admin'
        ? [null]
        : branches.filter(({ status }) => status === 'active').map(({ id }) => id);
    return scopes
      .filter((branchId) => canGrant(actor, role, branchId))
      .map((branchId) => ({ role, branchId }));
  });
}

export function roleAssignmentHints(assignments: readonly Pick<RoleScope, 'role'>[]): string[] {
  const roles = new Set(assignments.map(({ role }) => role));
  const hints: string[] = [];
  if (
    roles.has('org_admin') &&
    (roles.has('branch_manager') || roles.has('doctor') || roles.has('receptionist'))
  ) {
    hints.push("Organization admin already covers most of this branch role's tasks.");
  }
  if (roles.has('doctor') && roles.has('receptionist')) {
    hints.push('This person can verify patient identity through the receptionist role.');
  }
  return hints;
}

export const roleLabel: Record<StaffRole, string> = {
  org_owner: 'Organization owner',
  org_admin: 'Organization admin',
  branch_manager: 'Branch manager',
  doctor: 'Doctor',
  receptionist: 'Receptionist',
};

export function canEditRoles(
  actor: readonly RoleScope[],
  target: readonly MemberRole[],
  isSelf: boolean,
): boolean {
  if (!hasPermission(actor, 'member.manage')) return false;
  if (isSelf) return target.length > 1 && target.some(({ role }) => role !== 'org_owner');
  return (
    outranksStaffMember(actor, target) &&
    target.every(({ branchId }) => canManageBranch(actor, 'member.manage', branchId ?? null))
  );
}

export function canRemoveMember(
  actor: readonly RoleScope[],
  target: readonly MemberRole[],
  isSelf: boolean,
): boolean {
  return (
    !isSelf &&
    outranksStaffMember(actor, target) &&
    (canManageBranch(actor, 'member.manage', null) ||
      (target.length > 0 &&
        target.every(({ branchId }) => canManageBranch(actor, 'member.manage', branchId ?? null))))
  );
}
