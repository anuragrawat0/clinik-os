export const staffRoles = [
  'org_owner',
  'org_admin',
  'branch_manager',
  'doctor',
  'receptionist',
] as const;
export type StaffRole = (typeof staffRoles)[number];
export type Role = StaffRole | 'platform_admin' | 'patient';

export type Permission =
  | 'platform.org.manage'
  | 'org.read'
  | 'org.update'
  | 'org.ownership.transfer'
  | 'branch.manage'
  | 'branch.update'
  | 'member.list'
  | 'member.manage'
  | 'audit.read';

export type RoleScope = { role: Role; branchId: string | null };
type Scope = 'P' | 'O' | 'B';

const orgAdministration = {
  'org.read': 'O',
  'org.update': 'O',
  'branch.manage': 'O',
  'branch.update': 'O',
  'member.list': 'O',
  'member.manage': 'O',
  'audit.read': 'O',
} as const;

export const rolePermissions: Record<Role, Partial<Record<Permission, Scope>>> = {
  platform_admin: { 'platform.org.manage': 'P' },
  org_owner: { ...orgAdministration, 'org.ownership.transfer': 'O' },
  org_admin: orgAdministration,
  branch_manager: {
    'org.read': 'O',
    'branch.update': 'B',
    'member.list': 'B',
    'member.manage': 'B',
  },
  doctor: { 'org.read': 'O' },
  receptionist: { 'org.read': 'O' },
  patient: {},
};

export function isStaffRole(role: string): role is StaffRole {
  return staffRoles.some((staffRole) => staffRole === role);
}

export function canGrant(
  actorRoles: readonly RoleScope[],
  role: StaffRole,
  branchId: string | null,
): boolean {
  if (role === 'org_owner')
    return branchId === null && actorRoles.some((actor) => actor.role === 'platform_admin');
  if (role === 'org_admin')
    return branchId === null && actorRoles.some((actor) => actor.role === 'org_owner');
  if (branchId === null) return false;
  return actorRoles.some(
    (actor) =>
      actor.role === 'org_owner' ||
      actor.role === 'org_admin' ||
      (actor.role === 'branch_manager' && actor.branchId === branchId && role !== 'branch_manager'),
  );
}
