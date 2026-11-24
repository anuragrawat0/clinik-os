import { rolePermissions, type Permission } from '@clinik/shared';
import { describe, expect, it } from 'vitest';
import { matrixRoles, matrixRows, type MatrixScope } from '../fixtures/rbac-matrix';

function normalize(value: MatrixScope | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? [value] : [...value].sort();
}

describe('independent conformance with docs/RBAC_MATRIX.md', () => {
  it('pins every matrix row, role and scope against rolePermissions', () => {
    const mismatches: string[] = [];
    for (const { row, permission, scopes } of matrixRows) {
      for (const role of matrixRoles) {
        const expected = normalize(scopes[role]);
        const actual = normalize(rolePermissions[role][permission]);
        if (JSON.stringify(expected) !== JSON.stringify(actual)) {
          mismatches.push(
            `${row} [${permission}] ${role}: matrix=${JSON.stringify(expected)} code=${JSON.stringify(actual)}`,
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('grants clinical permissions only to the doctor role (D3)', () => {
    const clinical: Permission[] = [
      'clinical.read',
      'clinical.released.read',
      'clinical.write',
      'clinical.allergy.write',
      'lab.order.read',
      'clinical.file.access',
    ];
    for (const role of ['org_owner', 'org_admin'] as const) {
      for (const permission of clinical) {
        expect(rolePermissions[role][permission], `${role} ${permission}`).toBeUndefined();
      }
    }
    for (const permission of clinical) {
      expect(rolePermissions.doctor[permission], `doctor ${permission}`).toBeDefined();
    }
  });

  it('gives the platform administrator zero tenant permissions', () => {
    expect(rolePermissions.platform_admin).toEqual({ 'platform.org.manage': 'P' });
  });
});
