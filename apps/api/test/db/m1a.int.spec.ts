import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/core/db/migrate';
import { withTenantTransaction } from '../../src/core/db/transaction-context';
import { assertExpectedSqlState } from '../../src/core/db/trigger-test-helper';
import { findRuntimeRoleViolations, readRuntimeRoleState } from '../../src/core/db/role-self-check';
import { findMissingUpdatedAtTriggers, findTenantRlsViolations } from './schema-invariants';
import {
  type DatabaseHarness,
  migrationsDirectory,
  organizationA,
  organizationB,
  startDatabaseHarness,
} from './harness';

const userA = '20000000-0000-0000-0000-000000000001';
const userOther = '20000000-0000-0000-0000-000000000002';
const branchA = '30000000-0000-0000-0000-000000000001';
const branchB = '30000000-0000-0000-0000-000000000002';
const m1aTables = [
  'users',
  'sessions',
  'auth_tokens',
  'organizations',
  'branches',
  'organization_members',
  'staff_role_assignments',
  'invitations',
  'tenant_counters',
  'audit_logs',
];

let harness: DatabaseHarness;
let appDatabase: ReturnType<typeof drizzle>;
let workerDatabase: ReturnType<typeof drizzle>;

async function expectSqlState(operation: Promise<unknown>, acceptedCodes: string[]): Promise<void> {
  try {
    await operation;
  } catch (error) {
    assertExpectedSqlState(error, acceptedCodes);
    return;
  }
  throw new Error(`Expected SQLSTATE ${acceptedCodes.join(' or ')} but the statement succeeded.`);
}

async function seedM1aRows(): Promise<void> {
  await harness.adminPool.query(`
    TRUNCATE audit_logs, invitations, staff_role_assignments, organization_members, tenant_counters,
             branches, sessions, auth_tokens, organizations, users RESTART IDENTITY CASCADE
  `);
  await harness.adminPool.query(
    `INSERT INTO organizations (id, name, slug) VALUES
       ($1, 'Clinic A', 'clinic-a'), ($2, 'Clinic B', 'clinic-b')`,
    [organizationA, organizationB],
  );
  await harness.adminPool.query(
    `INSERT INTO users (id, email, full_name) VALUES
       ($1, 'staff-a@example.test', 'Staff A'), ($2, 'staff-other@example.test', 'Staff Other')`,
    [userA, userOther],
  );
  await harness.adminPool.query(
    `INSERT INTO branches (id, organization_id, name, code, timezone) VALUES
       ($1, $3, 'Branch A', 'BRA', 'Asia/Kolkata'),
       ($2, $4, 'Branch B', 'BRB', 'Asia/Kolkata')`,
    [branchA, branchB, organizationA, organizationB],
  );
  await harness.adminPool.query(
    `INSERT INTO invitations
         (organization_id, email, role, branch_id, patient_id, token_hash, invited_by, expires_at)
       VALUES
         ($1, 'doctor-a@example.test', 'doctor', $3, NULL, decode('01', 'hex'), $5, now() + interval '1 day'),
         ($2, 'reception-b@example.test', 'receptionist', $4, NULL, decode('02', 'hex'), $5, now() + interval '1 day')`,
    [organizationA, organizationB, branchA, branchB, userA],
  );
  await harness.adminPool.query(
    `INSERT INTO organization_members (organization_id, user_id) VALUES
       ($1, $3), ($2, $3), ($1, $4)`,
    [organizationA, organizationB, userA, userOther],
  );
  await harness.adminPool.query(
    `INSERT INTO staff_role_assignments (organization_id, user_id, role, branch_id) VALUES
       ($1, $3, 'doctor', $5), ($2, $3, 'org_owner', NULL), ($1, $4, 'receptionist', $5)`,
    [organizationA, organizationB, userA, userOther, branchA],
  );
  await harness.adminPool.query(
    `INSERT INTO tenant_counters (organization_id, counter, next_value) VALUES
       ($1, 'mrn', 10), ($2, 'mrn', 20)`,
    [organizationA, organizationB],
  );
  await harness.adminPool.query(
    `INSERT INTO audit_logs (organization_id, actor_type, action, resource_type, outcome) VALUES
       ($1, 'system', 'test.org_a', 'test', 'success'),
       ($2, 'system', 'test.org_b', 'test', 'success'),
       (NULL, 'system', 'test.platform', 'test', 'success')`,
    [organizationA, organizationB],
  );
}

describe('M1-A database and security foundation', () => {
  beforeAll(async () => {
    harness = await startDatabaseHarness();
    appDatabase = drizzle(harness.appPool);
    workerDatabase = drizzle(harness.workerPool);
  }, 180_000);

  afterAll(async () => {
    await harness?.stop();
  });

  beforeEach(async () => {
    await seedM1aRows();
  });

  it('rolls the M1-A migration down and reapplies it from the M0 baseline', async () => {
    await runMigrations(harness.connectionString('clinic_migrator'), 'down', migrationsDirectory);
    const missing = await harness.adminPool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_tables
        WHERE schemaname = 'public' AND tablename = ANY($1)`,
      [m1aTables],
    );
    expect(missing.rows[0]?.count).toBe(0);

    await runMigrations(harness.connectionString('clinic_migrator'), 'up', migrationsDirectory);
    const restored = await harness.adminPool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_tables
        WHERE schemaname = 'public' AND tablename = ANY($1)`,
      [m1aTables],
    );
    expect(restored.rows[0]?.count).toBe(m1aTables.length);
    await seedM1aRows();
  });

  it('creates all approved tables, constraints, and indexes', async () => {
    const tables = await harness.adminPool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename = ANY($1) ORDER BY tablename`,
      [m1aTables],
    );
    expect(tables.rows.map((row) => row.tablename)).toEqual([...m1aTables].sort());

    const constraints = await harness.adminPool.query<{
      table_name: string;
      definition: string;
    }>(
      `SELECT relation.relname AS table_name, pg_get_constraintdef(constraint_row.oid) AS definition
         FROM pg_constraint AS constraint_row
         JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
         JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public' AND relation.relname = ANY($1)`,
      [m1aTables],
    );
    const definitions = (tableName: string): string[] =>
      constraints.rows
        .filter((row) => row.table_name === tableName)
        .map((row) => row.definition.toLowerCase());

    expect(definitions('users').join(' ')).toContain('email');
    expect(definitions('users').join(' ')).toContain('(length(full_name) >= 1)');
    expect(definitions('users').join(' ')).toContain('(length(full_name) <= 200)');
    expect(definitions('users').join(' ')).toContain('password_hash is not null');
    expect(definitions('sessions').join(' ')).toContain('references users(id) on delete cascade');
    expect(definitions('sessions').join(' ')).toContain('token_hash');
    expect(definitions('sessions').join(' ')).toContain('absolute_expires_at > created_at');
    expect(definitions('auth_tokens').join(' ')).toContain(
      'references users(id) on delete cascade',
    );
    expect(definitions('auth_tokens').join(' ')).toContain('password_reset');
    expect(definitions('organizations').join(' ')).toContain('slug ~');
    expect(definitions('organizations').join(' ')).toContain("currency = 'inr'");
    expect(definitions('branches').join(' ')).toContain('references organizations(id)');
    expect(definitions('branches').join(' ')).toContain('unique (organization_id, id)');
    expect(definitions('branches').join(' ')).toContain('unique (organization_id, code)');
    expect(definitions('organization_members').join(' ')).toContain(
      'primary key (organization_id, user_id)',
    );
    expect(definitions('organization_members').join(' ')).toContain('references organizations(id)');
    expect(definitions('organization_members').join(' ')).toContain('references users(id)');
    expect(definitions('staff_role_assignments').join(' ')).toContain(
      'foreign key (organization_id, user_id) references organization_members',
    );
    expect(definitions('staff_role_assignments').join(' ')).toContain(
      'foreign key (organization_id, branch_id) references branches',
    );
    expect(definitions('staff_role_assignments').join(' ')).toContain('branch_manager');
    expect(definitions('staff_role_assignments').join(' ')).toContain('unique nulls not distinct');
    expect(definitions('invitations').join(' ')).toContain('references organizations(id)');
    expect(definitions('invitations').join(' ')).toContain('references users(id)');
    expect(definitions('invitations').join(' ')).toContain(
      'foreign key (organization_id, branch_id) references branches',
    );
    expect(definitions('invitations').join(' ')).toContain('branch_manager');
    expect(definitions('invitations').join(' ')).toContain('patient_id is null');
    expect(definitions('invitations').join(' ')).toContain('accepted_at is null');
    expect(definitions('invitations').join(' ')).not.toContain("role = 'patient'");
    expect(definitions('tenant_counters').join(' ')).toContain('references organizations(id)');
    expect(definitions('tenant_counters').join(' ')).toContain("counter = any (array['mrn'");
    expect(definitions('tenant_counters').join(' ')).toContain('next_value > 0');
    expect(definitions('audit_logs').join(' ')).toContain('primary key (id)');
    expect(definitions('audit_logs').join(' ')).toContain("actor_type = any (array['user'");
    expect(definitions('audit_logs').join(' ')).toContain("outcome = any (array['success'");

    const indexes = await harness.adminPool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = ANY($1)`,
      [m1aTables],
    );
    const indexNames = new Set(indexes.rows.map((row) => row.indexname));
    for (const indexName of [
      'sessions_user_active_idx',
      'auth_tokens_user_idx',
      'organization_members_user_idx',
      'staff_roles_one_owner_uq',
      'staff_roles_branch_idx',
      'staff_roles_user_idx',
      'invitations_pending_uq',
      'audit_org_time_idx',
      'audit_patient_time_idx',
      'audit_actor_time_idx',
    ]) {
      expect(indexNames.has(indexName), `missing index ${indexName}`).toBe(true);
    }
  });

  it('keeps clinic_app non-owner and without BYPASSRLS', async () => {
    const state = await readRuntimeRoleState(harness.appPool);
    expect(state.currentUser).toBe('clinic_app');
    expect(state.rolbypassrls).toBe(false);
    expect(state.ownedPublicRelations).toBe(0);
    expect(findRuntimeRoleViolations(state, 'clinic_app')).toEqual([]);

    const owners = await harness.adminPool.query<{ owner: string }>(
      `SELECT DISTINCT pg_get_userbyid(relation.relowner) AS owner
         FROM pg_class AS relation
         JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public' AND relation.relname = ANY($1)`,
      [m1aTables],
    );
    expect(new Set(owners.rows.map((row) => row.owner))).toEqual(new Set(['clinic_migrator']));
  });

  it('fails closed for ordinary tenant rows and rejects cross-tenant reads and writes', async () => {
    const withoutContext = await Promise.all([
      harness.appPool.query('SELECT id FROM branches'),
      harness.appPool.query('SELECT id FROM invitations'),
      harness.appPool.query('SELECT organization_id FROM tenant_counters'),
    ]);
    expect(withoutContext.map((result) => result.rowCount)).toEqual([0, 0, 0]);

    await expectSqlState(
      harness.appPool.query(
        `INSERT INTO branches (organization_id, name, code, timezone)
         VALUES ($1, 'No Context', 'NOC', 'UTC')`,
        [organizationA],
      ),
      ['42501'],
    );

    await withTenantTransaction(appDatabase, { orgId: organizationA }, async (tx) => {
      const otherBranch = await tx.execute(sql`SELECT id FROM branches WHERE id = ${branchB}`);
      expect(otherBranch.rowCount).toBe(0);
      const otherCounter = await tx.execute(
        sql`SELECT next_value FROM tenant_counters WHERE organization_id = ${organizationB}`,
      );
      expect(otherCounter.rowCount).toBe(0);
      const otherInvitation = await tx.execute(
        sql`SELECT id FROM invitations WHERE organization_id = ${organizationB}`,
      );
      expect(otherInvitation.rowCount).toBe(0);

      const hiddenUpdate = await tx.execute(
        sql`UPDATE branches SET name = 'Cross Tenant' WHERE id = ${branchB}`,
      );
      expect(hiddenUpdate.rowCount).toBe(0);
      const hiddenCounterUpdate = await tx.execute(sql`
        UPDATE tenant_counters SET next_value = next_value + 1
        WHERE organization_id = ${organizationB}
      `);
      expect(hiddenCounterUpdate.rowCount).toBe(0);
    });

    await expectSqlState(
      withTenantTransaction(appDatabase, { orgId: organizationA }, (tx) =>
        tx.execute(sql`
          INSERT INTO branches (organization_id, name, code, timezone)
          VALUES (${organizationB}, 'Cross Tenant', 'XBR', 'UTC')
        `),
      ),
      ['42501'],
    );
    await expectSqlState(
      withTenantTransaction(appDatabase, { orgId: organizationA }, (tx) =>
        tx.execute(sql`
        INSERT INTO tenant_counters (organization_id, counter)
        VALUES (${organizationB}, 'invoice')
      `),
      ),
      ['42501'],
    );
    await expectSqlState(
      withTenantTransaction(appDatabase, { orgId: organizationA }, (tx) =>
        tx.execute(sql`
          INSERT INTO invitations
            (organization_id, email, role, branch_id, token_hash, invited_by, expires_at)
          VALUES
            (${organizationB}, 'cross-tenant@example.test', 'doctor', ${branchB}, ${Buffer.from('cross-tenant')}, ${userA}, now() + interval '1 day')
        `),
      ),
      ['42501'],
    );
    expect(await findTenantRlsViolations(harness.adminPool)).toEqual([]);
  });

  it('supports only the M1 staff invitation roles and preserves final-schema patient_id staging', async () => {
    const visible = await withTenantTransaction(appDatabase, { orgId: organizationA }, (tx) =>
      tx.execute(sql`SELECT role, branch_id, patient_id FROM invitations`),
    );
    expect(visible.rows).toEqual([{ role: 'doctor', branch_id: branchA, patient_id: null }]);

    await withTenantTransaction(appDatabase, { orgId: organizationA }, async (tx) => {
      for (const [index, role] of [
        'org_owner',
        'org_admin',
        'branch_manager',
        'doctor',
        'receptionist',
      ].entries()) {
        const branchId = role === 'org_owner' || role === 'org_admin' ? null : branchA;
        await tx.execute(sql`
          INSERT INTO invitations
            (organization_id, email, role, branch_id, token_hash, invited_by, expires_at)
          VALUES
            (${organizationA}, ${`role-${index}@example.test`}, ${role}, ${branchId}, ${Buffer.from(`role-${index}`)}, ${userA}, now() + interval '1 day')
        `);
      }
    });

    await withTenantTransaction(appDatabase, { orgId: organizationA }, (tx) =>
      tx.execute(sql`
        INSERT INTO invitations
          (organization_id, email, role, token_hash, invited_by, expires_at)
        VALUES
          (${organizationA}, 'owner-pending@example.test', 'org_owner', ${Buffer.from('pending-owner')}, ${userA}, now() + interval '1 day')
      `),
    );
    await expectSqlState(
      withTenantTransaction(appDatabase, { orgId: organizationA }, (tx) =>
        tx.execute(sql`
        INSERT INTO invitations
          (organization_id, email, role, token_hash, invited_by, expires_at)
        VALUES
          (${organizationA}, 'OWNER-PENDING@example.test', 'org_owner', ${Buffer.from('duplicate-owner')}, ${userA}, now() + interval '1 day')
      `),
      ),
      ['23505'],
    );
    await withTenantTransaction(appDatabase, { orgId: organizationA }, (tx) =>
      tx.execute(sql`
        INSERT INTO invitations
          (organization_id, email, role, token_hash, invited_by, expires_at, accepted_at)
        VALUES
          (${organizationA}, 'owner-pending@example.test', 'org_owner', ${Buffer.from('accepted-owner')}, ${userA}, now() + interval '1 day', now())
      `),
    );

    await expectSqlState(
      withTenantTransaction(appDatabase, { orgId: organizationA }, (tx) =>
        tx.execute(sql`
        INSERT INTO invitations
          (organization_id, email, role, token_hash, invited_by, expires_at)
        VALUES
          (${organizationA}, 'patient@example.test', 'patient', ${Buffer.from('patient')}, ${userA}, now() + interval '1 day')
      `),
      ),
      ['23514'],
    );
    await expectSqlState(
      withTenantTransaction(appDatabase, { orgId: organizationA }, (tx) =>
        tx.execute(sql`
        INSERT INTO invitations
          (organization_id, email, role, branch_id, token_hash, invited_by, expires_at)
        VALUES
          (${organizationA}, 'owner-with-branch@example.test', 'org_owner', ${branchA}, ${Buffer.from('bad-scope')}, ${userA}, now() + interval '1 day')
      `),
      ),
      ['23514'],
    );
    await expectSqlState(
      withTenantTransaction(appDatabase, { orgId: organizationA }, (tx) =>
        tx.execute(sql`
        INSERT INTO invitations
          (organization_id, email, role, branch_id, token_hash, invited_by, expires_at)
        VALUES
          (${organizationA}, 'wrong-branch@example.test', 'doctor', ${branchB}, ${Buffer.from('wrong-branch')}, ${userA}, now() + interval '1 day')
      `),
      ),
      ['23503'],
    );
    await expectSqlState(
      withTenantTransaction(appDatabase, { orgId: organizationA }, (tx) =>
        tx.execute(sql`
        INSERT INTO invitations
          (organization_id, email, role, branch_id, token_hash, invited_by, expires_at, accepted_at, revoked_at)
        VALUES
          (${organizationA}, 'accepted-revoked@example.test', 'doctor', ${branchA}, ${Buffer.from('accepted-revoked')}, ${userA}, now() + interval '1 day', now(), now())
      `),
      ),
      ['23514'],
    );

    const patientSchema = await harness.adminPool.query<{
      patient_table: string | null;
      has_patient_id: boolean;
    }>(`
      SELECT to_regclass('public.patients')::text AS patient_table,
             EXISTS (
               SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'invitations' AND column_name = 'patient_id'
             ) AS has_patient_id
    `);
    expect(patientSchema.rows[0]).toEqual({ patient_table: null, has_patient_id: true });
  });

  it('allows current-user membership lookup before organization selection and restricts writes', async () => {
    const lookup = await appDatabase.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_org_id', '', true)`);
      await tx.execute(sql`SELECT set_config('app.current_user_id', ${userA}, true)`);
      const members = await tx.execute(
        sql`SELECT organization_id, user_id FROM organization_members ORDER BY organization_id`,
      );
      const roles = await tx.execute(
        sql`SELECT organization_id, role FROM staff_role_assignments ORDER BY organization_id`,
      );
      return { members: members.rows, roles: roles.rows };
    });
    expect(lookup.members).toEqual([
      { organization_id: organizationA, user_id: userA },
      { organization_id: organizationB, user_id: userA },
    ]);
    expect(lookup.roles).toEqual([
      { organization_id: organizationA, role: 'doctor' },
      { organization_id: organizationB, role: 'org_owner' },
    ]);

    const updated = await appDatabase.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_org_id', '', true)`);
      await tx.execute(sql`SELECT set_config('app.current_user_id', ${userA}, true)`);
      return tx.execute(sql`
        UPDATE organization_members SET status = 'suspended'
        WHERE organization_id = ${organizationA} AND user_id = ${userA}
      `);
    });
    expect(updated.rowCount).toBe(0);

    const roleUpdate = await appDatabase.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_org_id', '', true)`);
      await tx.execute(sql`SELECT set_config('app.current_user_id', ${userA}, true)`);
      return tx.execute(sql`
        UPDATE staff_role_assignments SET role = 'org_admin', branch_id = NULL
        WHERE organization_id = ${organizationA} AND user_id = ${userA}
      `);
    });
    expect(roleUpdate.rowCount).toBe(0);

    await expectSqlState(
      appDatabase.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_org_id', '', true)`);
        await tx.execute(sql`SELECT set_config('app.current_user_id', ${userA}, true)`);
        await tx.execute(sql`
          INSERT INTO organization_members (organization_id, user_id)
          VALUES (${organizationB}, ${userOther})
        `);
      }),
      ['42501'],
    );
    await expectSqlState(
      appDatabase.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_org_id', '', true)`);
        await tx.execute(sql`SELECT set_config('app.current_user_id', ${userA}, true)`);
        await tx.execute(sql`
          INSERT INTO staff_role_assignments (organization_id, user_id, role, branch_id)
          VALUES (${organizationB}, ${userA}, 'org_admin', NULL)
        `);
      }),
      ['42501'],
    );

    const writeInSelectedOrg = await withTenantTransaction(
      appDatabase,
      { orgId: organizationA, userId: userA },
      (tx) =>
        tx.execute(sql`
        UPDATE organization_members SET status = 'suspended'
        WHERE organization_id = ${organizationA} AND user_id = ${userA}
      `),
    );
    expect(writeInSelectedOrg.rowCount).toBe(1);
  });

  it('clears transaction-local tenant context on the same pooled app connection after commit', async () => {
    const client = await harness.appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_org_id', $1, true)", [organizationA]);
      await client.query("SELECT set_config('app.current_user_id', $1, true)", [userA]);
      const scoped = await client.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM branches',
      );
      expect(scoped.rows[0]?.count).toBe(1);
      await client.query('COMMIT');

      const cleared = await client.query<{ org_id: string | null; user_id: string | null }>(
        `SELECT public.app_current_org() AS org_id, public.app_current_user() AS user_id`,
      );
      expect(cleared.rows[0]).toEqual({ org_id: null, user_id: null });
    } finally {
      client.release();
    }
  });

  it('limits clinic_worker to the documented M1-A grants', async () => {
    for (const table of ['users', 'sessions', 'auth_tokens', 'organizations', 'invitations']) {
      await expectSqlState(harness.workerPool.query(`SELECT * FROM ${table} LIMIT 1`), ['42501']);
    }
    const noContextBranches = await harness.workerPool.query('SELECT id FROM branches');
    expect(noContextBranches.rowCount).toBe(0);
    const workerBranch = await withTenantTransaction(
      workerDatabase,
      { orgId: organizationA },
      (tx) => tx.execute(sql`SELECT id FROM branches`),
    );
    expect(workerBranch.rows).toEqual([{ id: branchA }]);
    await withTenantTransaction(workerDatabase, { orgId: organizationA }, async (tx) => {
      const counterUpdate = await tx.execute(sql`
        UPDATE tenant_counters SET next_value = next_value + 1
        WHERE organization_id = ${organizationA} AND counter = 'mrn'
      `);
      expect(counterUpdate.rowCount).toBe(1);
      await tx.execute(sql`
        INSERT INTO audit_logs (organization_id, actor_type, action, resource_type, outcome)
        VALUES (${organizationA}, 'system', 'test.worker', 'test', 'success')
      `);
    });
    await expectSqlState(
      harness.workerPool.query(
        "UPDATE audit_logs SET action = 'tampered' WHERE action = 'test.worker'",
      ),
      ['42501'],
    );

    const privileges = await harness.adminPool.query<{
      branches_select: boolean;
      branches_insert: boolean;
      counters_select: boolean;
      counters_insert: boolean;
      counters_update: boolean;
      counters_delete: boolean;
      audit_select: boolean;
      audit_insert: boolean;
      audit_update: boolean;
      audit_delete: boolean;
      member_select: boolean;
      staff_role_select: boolean;
      invitations_select: boolean;
      invitations_insert: boolean;
    }>(`
      SELECT has_table_privilege('clinic_worker', 'public.branches', 'SELECT') AS branches_select,
             has_table_privilege('clinic_worker', 'public.branches', 'INSERT') AS branches_insert,
             has_table_privilege('clinic_worker', 'public.tenant_counters', 'SELECT') AS counters_select,
             has_table_privilege('clinic_worker', 'public.tenant_counters', 'INSERT') AS counters_insert,
             has_table_privilege('clinic_worker', 'public.tenant_counters', 'UPDATE') AS counters_update,
             has_table_privilege('clinic_worker', 'public.tenant_counters', 'DELETE') AS counters_delete,
             has_table_privilege('clinic_worker', 'public.audit_logs', 'SELECT') AS audit_select,
             has_table_privilege('clinic_worker', 'public.audit_logs', 'INSERT') AS audit_insert,
             has_table_privilege('clinic_worker', 'public.audit_logs', 'UPDATE') AS audit_update,
             has_table_privilege('clinic_worker', 'public.audit_logs', 'DELETE') AS audit_delete,
             has_table_privilege('clinic_worker', 'public.organization_members', 'SELECT') AS member_select,
             has_table_privilege('clinic_worker', 'public.staff_role_assignments', 'SELECT') AS staff_role_select,
             has_table_privilege('clinic_worker', 'public.invitations', 'SELECT') AS invitations_select,
             has_table_privilege('clinic_worker', 'public.invitations', 'INSERT') AS invitations_insert
    `);
    expect(privileges.rows[0]).toEqual({
      branches_select: true,
      branches_insert: false,
      counters_select: true,
      counters_insert: true,
      counters_update: true,
      counters_delete: false,
      audit_select: true,
      audit_insert: true,
      audit_update: false,
      audit_delete: false,
      member_select: false,
      staff_role_select: false,
      invitations_select: false,
      invitations_insert: false,
    });
  });

  it('allows scoped and platform audit inserts, scopes reads, and enforces both append-only protections', async () => {
    const appAuditPrivileges = await harness.adminPool.query<{ update: boolean; delete: boolean }>(`
      SELECT has_table_privilege('clinic_app', 'public.audit_logs', 'UPDATE') AS update,
             has_table_privilege('clinic_app', 'public.audit_logs', 'DELETE') AS delete
    `);
    expect(appAuditPrivileges.rows[0]).toEqual({ update: false, delete: false });

    await withTenantTransaction(
      appDatabase,
      { orgId: organizationA, userId: userA },
      async (tx) => {
        const visible = await tx.execute(sql`SELECT action FROM audit_logs ORDER BY action`);
        expect(visible.rows).toEqual([{ action: 'test.org_a' }]);

        await tx.execute(sql`
        INSERT INTO audit_logs (organization_id, actor_type, action, resource_type, outcome)
        VALUES (${organizationA}, 'user', 'test.app', 'test', 'success')
      `);
        await tx.execute(sql`
        INSERT INTO audit_logs (organization_id, actor_type, action, resource_type, outcome)
        VALUES (NULL, 'system', 'test.platform_app', 'test', 'success')
      `);
      },
    );

    await expectSqlState(
      withTenantTransaction(appDatabase, { orgId: organizationA }, (tx) =>
        tx.execute(sql`
        INSERT INTO audit_logs (organization_id, actor_type, action, resource_type, outcome)
        VALUES (${organizationB}, 'user', 'test.cross', 'test', 'success')
      `),
      ),
      ['42501'],
    );
    await expectSqlState(
      harness.appPool.query(
        "UPDATE audit_logs SET action = 'tampered' WHERE action = 'test.org_a'",
      ),
      ['42501'],
    );
    await expectSqlState(
      harness.appPool.query("DELETE FROM audit_logs WHERE action = 'test.org_a'"),
      ['42501'],
    );

    await expectSqlState(
      harness.adminPool.query(
        "UPDATE audit_logs SET action = 'tampered' WHERE action = 'test.org_a'",
      ),
      ['23514'],
    );
    await expectSqlState(
      harness.adminPool.query("DELETE FROM audit_logs WHERE action = 'test.org_a'"),
      ['23514'],
    );
  });

  it('attaches T1 to each M1-A updated_at table and advances its timestamp', async () => {
    const missing = await findMissingUpdatedAtTriggers(harness.adminPool);
    expect(
      missing.filter((row) => ['users', 'organizations', 'branches'].includes(row.table)),
    ).toEqual([]);

    const before = await harness.adminPool.query<{ table_name: string; updated_at: Date }>(`
      SELECT 'users' AS table_name, updated_at FROM users WHERE id = '${userA}'
      UNION ALL
      SELECT 'organizations', updated_at FROM organizations WHERE id = '${organizationA}'
      UNION ALL
      SELECT 'branches', updated_at FROM branches WHERE id = '${branchA}'
    `);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));

    await harness.appPool.query('UPDATE users SET full_name = full_name WHERE id = $1', [userA]);
    await harness.appPool.query('UPDATE organizations SET name = name WHERE id = $1', [
      organizationA,
    ]);
    await withTenantTransaction(appDatabase, { orgId: organizationA }, (tx) =>
      tx.execute(sql`UPDATE branches SET name = name WHERE id = ${branchA}`),
    );

    const after = await harness.adminPool.query<{ table_name: string; updated_at: Date }>(`
      SELECT 'users' AS table_name, updated_at FROM users WHERE id = '${userA}'
      UNION ALL
      SELECT 'organizations', updated_at FROM organizations WHERE id = '${organizationA}'
      UNION ALL
      SELECT 'branches', updated_at FROM branches WHERE id = '${branchA}'
    `);
    const beforeByTable = new Map(
      before.rows.map((row) => [row.table_name, row.updated_at.getTime()]),
    );
    for (const row of after.rows) {
      expect(row.updated_at.getTime()).toBeGreaterThan(beforeByTable.get(row.table_name) ?? 0);
    }
  });
});
