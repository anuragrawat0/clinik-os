import { canGrant, staffRoles, type Role, type RoleScope, type StaffRole } from '@clinik/shared';
import { describe, expect, it } from 'vitest';

const own = 'own-branch';
const other = 'other-branch';
const matrix: Record<Role, readonly StaffRole[][]> = {
  platform_admin: [['org_owner'], [], []],
  org_owner: [
    ['org_admin'],
    ['branch_manager', 'doctor', 'receptionist'],
    ['branch_manager', 'doctor', 'receptionist'],
  ],
  org_admin: [
    [],
    ['branch_manager', 'doctor', 'receptionist'],
    ['branch_manager', 'doctor', 'receptionist'],
  ],
  branch_manager: [[], ['doctor', 'receptionist'], []],
  doctor: [[], [], []],
  receptionist: [[], [], []],
  patient: [[], [], []],
};

describe('canGrant', () => {
  for (const role of Object.keys(matrix) as Role[]) {
    const branchId =
      role === 'branch_manager' || role === 'doctor' || role === 'receptionist' ? own : null;
    const actor: RoleScope = { role, branchId };
    it.each([null, own, other])(`${role} at grant scope %s`, (scope) => {
      const allowed = matrix[role][[null, own, other].indexOf(scope)];
      for (const target of staffRoles)
        expect(canGrant([actor], target, scope), target).toBe(allowed.includes(target));
    });
  }

  it('combines permissions across roles and managed branches', () => {
    const actors: RoleScope[] = [
      { role: 'branch_manager', branchId: other },
      { role: 'branch_manager', branchId: own },
      { role: 'receptionist', branchId: 'third-branch' },
    ];
    expect(canGrant(actors, 'doctor', own)).toBe(true);
    expect(canGrant(actors, 'doctor', other)).toBe(true);
    expect(canGrant(actors, 'doctor', 'third-branch')).toBe(false);
    expect(canGrant([], 'doctor', own)).toBe(false);
  });
});
