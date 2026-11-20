import { describe, expect, it } from 'vitest';
import {
  findRuntimeRoleViolations,
  type RuntimeRoleState,
} from '../../src/core/db/role-self-check';

function safeRole(overrides: Partial<RuntimeRoleState> = {}): RuntimeRoleState {
  return {
    currentUser: 'clinic_app',
    rolsuper: false,
    rolbypassrls: false,
    rolcreatedb: false,
    rolcreaterole: false,
    roleMemberships: 0,
    ownedPublicRelations: 0,
    ...overrides,
  };
}

describe('runtime database role self-check', () => {
  it('accepts a least-privilege application role', () => {
    expect(findRuntimeRoleViolations(safeRole(), 'clinic_app')).toEqual([]);
    expect(
      findRuntimeRoleViolations(safeRole({ currentUser: 'clinic_worker' }), 'clinic_worker'),
    ).toEqual([]);
  });

  it('rejects the wrong current role', () => {
    expect(findRuntimeRoleViolations(safeRole({ currentUser: 'postgres' }), 'clinic_app')).toEqual([
      'expected to connect as clinic_app but connected as postgres',
    ]);
  });

  it('rejects a superuser', () => {
    expect(findRuntimeRoleViolations(safeRole({ rolsuper: true }), 'clinic_app')).toContain(
      'clinic_app must not be a superuser',
    );
  });

  it('rejects BYPASSRLS', () => {
    expect(findRuntimeRoleViolations(safeRole({ rolbypassrls: true }), 'clinic_app')).toContain(
      'clinic_app must not have BYPASSRLS',
    );
  });

  it('rejects CREATEDB', () => {
    expect(findRuntimeRoleViolations(safeRole({ rolcreatedb: true }), 'clinic_app')).toContain(
      'clinic_app must not have CREATEDB',
    );
  });

  it('rejects CREATEROLE', () => {
    expect(findRuntimeRoleViolations(safeRole({ rolcreaterole: true }), 'clinic_app')).toContain(
      'clinic_app must not have CREATEROLE',
    );
  });

  it('rejects role inheritance and SET ROLE access', () => {
    expect(findRuntimeRoleViolations(safeRole({ roleMemberships: 1 }), 'clinic_app')).toContain(
      'clinic_app must not inherit from or SET ROLE to another role',
    );
  });

  it('rejects ownership of protected relations', () => {
    expect(
      findRuntimeRoleViolations(safeRole({ ownedPublicRelations: 2 }), 'clinic_app'),
    ).toContain('clinic_app must not own relations in the public schema');
  });

  it('reports every unsafe property, not just the first', () => {
    const violations = findRuntimeRoleViolations(
      safeRole({
        currentUser: 'clinic_migrator',
        rolsuper: true,
        rolbypassrls: true,
        rolcreatedb: true,
        rolcreaterole: true,
        roleMemberships: 1,
        ownedPublicRelations: 1,
      }),
      'clinic_app',
    );
    expect(violations).toHaveLength(7);
  });
});
