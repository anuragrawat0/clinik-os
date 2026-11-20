import type { Pool } from 'pg';

export interface RuntimeRoleState {
  currentUser: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  roleMemberships: number;
  ownedPublicRelations: number;
}

const runtimeRoleStateQuery = `
  WITH me AS (
    SELECT oid, rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
      FROM pg_roles
     WHERE rolname = current_user
  )
  SELECT
    me.rolname AS "currentUser",
    me.rolsuper,
    me.rolbypassrls,
    me.rolcreatedb,
    me.rolcreaterole,
    (
      SELECT count(*)::int
        FROM pg_auth_members membership
       WHERE membership.member = me.oid
    ) AS "roleMemberships",
    (
      SELECT count(*)::int
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE relation.relowner = me.oid
         AND namespace.nspname = 'public'
         AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
    ) AS "ownedPublicRelations"
  FROM me
`;

export async function readRuntimeRoleState(pool: Pool): Promise<RuntimeRoleState> {
  const result = await pool.query<RuntimeRoleState>(runtimeRoleStateQuery);
  const state = result.rows[0];
  if (!state) {
    throw new Error('Could not read the current database role.');
  }
  return state;
}

export function findRuntimeRoleViolations(
  state: RuntimeRoleState,
  expectedRole: 'clinic_app' | 'clinic_worker',
): string[] {
  const violations: string[] = [];

  if (state.currentUser !== expectedRole) {
    violations.push(`expected to connect as ${expectedRole} but connected as ${state.currentUser}`);
  }
  if (state.rolsuper) {
    violations.push(`${expectedRole} must not be a superuser`);
  }
  if (state.rolbypassrls) {
    violations.push(`${expectedRole} must not have BYPASSRLS`);
  }
  if (state.rolcreatedb) {
    violations.push(`${expectedRole} must not have CREATEDB`);
  }
  if (state.rolcreaterole) {
    violations.push(`${expectedRole} must not have CREATEROLE`);
  }
  if (state.roleMemberships !== 0) {
    violations.push(`${expectedRole} must not inherit from or SET ROLE to another role`);
  }
  if (state.ownedPublicRelations !== 0) {
    violations.push(`${expectedRole} must not own relations in the public schema`);
  }

  return violations;
}
