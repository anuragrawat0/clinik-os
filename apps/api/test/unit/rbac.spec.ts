import {
  canGrant,
  rolePermissions,
  staffRoles,
  type Role,
  type RoleScope,
  type StaffRole,
} from '@clinik/shared';
import { describe, expect, it } from 'vitest';
import { coversBranch, ownsResource } from '../../src/core/access/access';

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

describe('permission catalogue', () => {
  it('snapshots every role, granted permission and scope', () => {
    expect(rolePermissions).toMatchSnapshot();
  });

  it('withholds clinical permissions from owners and admins without a doctor role (D3)', () => {
    const clinical = Object.keys(rolePermissions.doctor).filter((permission) =>
      /^(clinical\.|lab\.|telehealth\.consult$)/.test(permission),
    );
    expect(clinical).toContain('clinical.read');
    for (const role of ['org_owner', 'org_admin'] as const)
      for (const permission of clinical)
        expect(rolePermissions[role]).not.toHaveProperty([permission]);
  });

  it('grants the platform admin only the platform permission', () => {
    expect(rolePermissions.platform_admin).toEqual({ 'platform.org.manage': 'P' });
  });

  it('honors both branch and own scope without widening branch scope', () => {
    const actor = { orgId: 'org', roles: [{ role: 'doctor' as const, branchId: own }] };
    expect(coversBranch(actor, 'appointment.read', own)).toBe(true);
    expect(coversBranch(actor, 'appointment.read', other)).toBe(false);
    expect(coversBranch(actor, 'appointment.manage', own)).toBe(false);
    expect(coversBranch(actor, 'patient.demographics', other)).toBe(true);
  });
});

describe('ownsResource', () => {
  it('compares the treating doctor profile and the linked patient account', () => {
    const actor = { userId: 'user', doctorId: 'doctor-profile' };
    expect(ownsResource(actor, { doctorId: 'doctor-profile' })).toBe(true);
    expect(ownsResource(actor, { doctorId: 'user' })).toBe(false);
    expect(ownsResource(actor, { patientAccountUserId: 'user' })).toBe(true);
    expect(ownsResource(actor, { patientAccountUserId: 'other' })).toBe(false);
  });

  it('does not infer ownership from absent or null identifiers', () => {
    expect(ownsResource({ userId: 'user' }, {})).toBe(false);
    expect(ownsResource({ userId: 'user', doctorId: null }, { doctorId: null })).toBe(false);
    expect(ownsResource({ userId: 'user' }, { patientAccountUserId: null })).toBe(false);
  });
});
