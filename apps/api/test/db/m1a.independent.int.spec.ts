import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/core/db/migrate';
import { withTenantTransaction } from '../../src/core/db/transaction-context';
import { assertExpectedSqlState } from '../../src/core/db/trigger-test-helper';
import {
  type DatabaseHarness,
  migratorPassword,
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
] as const;

const tenantTables = [
  'branches',
  'organization_members',
  'staff_role_assignments',
  'invitations',
  'tenant_counters',
  'audit_logs',
] as const;

const nonTenantM1aTables = ['users', 'sessions', 'auth_tokens', 'organizations'] as const;

const expectedColumns: Record<(typeof m1aTables)[number], string[]> = {
  users: [
    'id',
    'email',
    'password_hash',
    'full_name',
    'phone',
    'is_platform_admin',
    'status',
    'email_verified_at',
    'failed_login_count',
    'locked_until',
    'last_login_at',
    'created_at',
    'updated_at',
  ],
  sessions: [
    'id',
    'user_id',
    'token_hash',
    'ip',
    'user_agent',
    'created_at',
    'last_seen_at',
    'idle_expires_at',
    'absolute_expires_at',
    'revoked_at',
  ],
  auth_tokens: [
    'id',
    'user_id',
    'purpose',
    'token_hash',
    'expires_at',
    'consumed_at',
    'created_at',
  ],
  organizations: [
    'id',
    'name',
    'slug',
    'status',
    'default_timezone',
    'currency',
    'created_at',
    'updated_at',
  ],
  branches: [
    'id',
    'organization_id',
    'name',
    'code',
    'timezone',
    'phone',
    'email',
    'address_line1',
    'address_line2',
    'city',
    'region',
    'postal_code',
    'country',
    'status',
    'created_at',
    'updated_at',
  ],
  organization_members: ['organization_id', 'user_id', 'status', 'joined_at'],
  staff_role_assignments: [
    'id',
    'organization_id',
    'user_id',
    'role',
    'branch_id',
    'created_by',
    'created_at',
  ],
  invitations: [
    'id',
    'organization_id',
    'email',
    'role',
    'branch_id',
    'patient_id',
    'token_hash',
    'invited_by',
    'expires_at',
    'accepted_at',
    'revoked_at',
    'created_at',
  ],
  tenant_counters: ['organization_id', 'counter', 'next_value'],
  audit_logs: [
    'id',
    'occurred_at',
    'organization_id',
    'branch_id',
    'actor_user_id',
    'actor_type',
    'actor_roles',
    'action',
    'resource_type',
    'resource_id',
    'patient_id',
    'outcome',
    'request_id',
    'ip',
    'user_agent',
    'changed_fields',
    'metadata',
  ],
};

const expectedNotNull: Record<(typeof m1aTables)[number], string[]> = {
  users: [
    'id',
    'email',
    'full_name',
    'is_platform_admin',
    'status',
    'failed_login_count',
    'created_at',
    'updated_at',
  ],
  sessions: [
    'id',
    'user_id',
    'token_hash',
    'created_at',
    'last_seen_at',
    'idle_expires_at',
    'absolute_expires_at',
  ],
  auth_tokens: ['id', 'user_id', 'purpose', 'token_hash', 'expires_at', 'created_at'],
  organizations: [
    'id',
    'name',
    'slug',
    'status',
    'default_timezone',
    'currency',
    'created_at',
    'updated_at',
  ],
  branches: [
    'id',
    'organization_id',
    'name',
    'code',
    'timezone',
    'status',
    'created_at',
    'updated_at',
  ],
  organization_members: ['organization_id', 'user_id', 'status', 'joined_at'],
  staff_role_assignments: ['id', 'organization_id', 'user_id', 'role', 'created_at'],
  invitations: [
    'id',
    'organization_id',
    'email',
    'role',
    'token_hash',
    'invited_by',
    'expires_at',
    'created_at',
  ],
  tenant_counters: ['organization_id', 'counter', 'next_value'],
  audit_logs: [
    'id',
    'occurred_at',
    'actor_type',
    'actor_roles',
    'action',
    'resource_type',
    'outcome',
    'metadata',
  ],
};

let harness: DatabaseHarness;
let appDatabase: ReturnType<typeof drizzle>;

async function expectSqlState(operation: Promise<unknown>, acceptedCodes: string[]): Promise<void> {
  try {
    await operation;
  } catch (error) {
    assertExpectedSqlState(error, acceptedCodes);
    return;
  }
  throw new Error(`Expected SQLSTATE ${acceptedCodes.join(' or ')} but the statement succeeded.`);
}

async function seedRows(): Promise<void> {
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
    `INSERT INTO invitations
         (organization_id, email, role, branch_id, patient_id, token_hash, invited_by, expires_at)
       VALUES
         ($1, 'doctor-a@example.test', 'doctor', $3, NULL, decode('01', 'hex'), $5, now() + interval '1 day'),
         ($2, 'reception-b@example.test', 'receptionist', $4, NULL, decode('02', 'hex'), $5, now() + interval '1 day')`,
    [organizationA, organizationB, branchA, branchB, userA],
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

async function effectivePrivileges(
  role: string,
  tables: readonly string[],
): Promise<Record<string, { select: boolean; insert: boolean; update: boolean; delete: boolean }>> {
  const result = await harness.adminPool.query<{
    table_name: string;
    can_select: boolean;
    can_insert: boolean;
    can_update: boolean;
    can_delete: boolean;
  }>(
    `SELECT relation AS table_name,
            has_table_privilege($1, relation, 'SELECT') AS can_select,
            has_table_privilege($1, relation, 'INSERT') AS can_insert,
            has_table_privilege($1, relation, 'UPDATE') AS can_update,
            has_table_privilege($1, relation, 'DELETE') AS can_delete
       FROM unnest($2::text[]) AS relation`,
    [role, tables.map((table) => `public.${table}`)],
  );
  return Object.fromEntries(
    result.rows.map((row) => [
      row.table_name.replace(/^public\./, ''),
      {
        select: row.can_select,
        insert: row.can_insert,
        update: row.can_update,
        delete: row.can_delete,
      },
    ]),
  );
}

describe('M1-A independent verification', () => {
  beforeAll(async () => {
    harness = await startDatabaseHarness();
    appDatabase = drizzle(harness.appPool);
  }, 180_000);

  afterAll(async () => {
    await harness?.stop();
  });

  beforeEach(async () => {
    await seedRows();
  });

  it('reaches M1-A from the real M0 baseline and reverses both migrations in a scratch database', async () => {
    const scratchDatabase = 'clinik_m1a_roundtrip';
    const host = harness.container.getHost();
    const port = harness.container.getMappedPort(5432);
    await harness.adminPool.query(`CREATE DATABASE ${scratchDatabase} OWNER clinic_migrator`);
    const scratchUrl = `postgresql://clinic_migrator:${migratorPassword}@${host}:${port}/${scratchDatabase}`;

    try {
      await runMigrations(scratchUrl, 'up', migrationsDirectory);
      const pool = new Pool({ connectionString: scratchUrl, max: 1 });
      try {
        const applied = await pool.query<{ name: string }>(
          `SELECT name FROM clinik_meta.schema_migrations ORDER BY name`,
        );
        expect(applied.rows.map((row) => row.name)).toEqual([
          '0001_foundations',
          '0002_m1a_identity_tenancy',
        ]);

        const tables = await pool.query<{ tablename: string }>(
          `SELECT tablename FROM pg_tables
              WHERE schemaname = 'public' AND tablename = ANY($1) ORDER BY tablename`,
          [m1aTables],
        );
        expect(tables.rows.map((row) => row.tablename)).toEqual([...m1aTables].sort());

        await runMigrations(scratchUrl, 'down', migrationsDirectory);
        const afterOneDown = await pool.query<{ name: string }>(
          `SELECT name FROM clinik_meta.schema_migrations ORDER BY name`,
        );
        expect(afterOneDown.rows.map((row) => row.name)).toEqual(['0001_foundations']);
        const m1aAfterDown = await pool.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM pg_tables
              WHERE schemaname = 'public' AND tablename = ANY($1)`,
          [m1aTables],
        );
        expect(m1aAfterDown.rows[0]?.count).toBe(0);
        const helpers = await pool.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM pg_proc
              WHERE proname IN ('app_current_org', 'app_current_user', 'set_updated_at')`,
        );
        expect(helpers.rows[0]?.count).toBe(3);

        await runMigrations(scratchUrl, 'up', migrationsDirectory);
        const reapplied = await pool.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM pg_tables
              WHERE schemaname = 'public' AND tablename = ANY($1)`,
          [m1aTables],
        );
        expect(reapplied.rows[0]?.count).toBe(m1aTables.length);

        await runMigrations(scratchUrl, 'down', migrationsDirectory);
        await runMigrations(scratchUrl, 'down', migrationsDirectory);
        const empty = await pool.query<{ table: string | null; function: string | null }>(
          `SELECT to_regclass('public.users')::text AS table,
                    to_regproc('public.app_current_org')::text AS function`,
        );
        expect(empty.rows[0]).toEqual({ table: null, function: null });

        await runMigrations(scratchUrl, 'up', migrationsDirectory);
        const final = await pool.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM pg_tables
              WHERE schemaname = 'public' AND tablename = ANY($1)`,
          [m1aTables],
        );
        expect(final.rows[0]?.count).toBe(m1aTables.length);
      } finally {
        await pool.end();
      }
    } finally {
      await harness.adminPool.query(`DROP DATABASE IF EXISTS ${scratchDatabase} WITH (FORCE)`);
    }
  }, 120_000);

  it('matches the approved column and NOT NULL inventory exactly', async () => {
    const columns = await harness.adminPool.query<{
      table_name: string;
      column_name: string;
      is_nullable: string;
      data_type: string;
      udt_name: string;
    }>(
      `SELECT table_name, column_name, is_nullable, data_type, udt_name
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY($1)
        ORDER BY table_name, ordinal_position`,
      [[...m1aTables]],
    );

    for (const table of m1aTables) {
      const rows = columns.rows.filter((row) => row.table_name === table);
      const names = rows.map((row) => row.column_name).sort();
      expect(names, `column set for ${table}`).toEqual([...expectedColumns[table]].sort());
      expect(
        rows
          .filter((row) => row.is_nullable === 'YES')
          .map((row) => row.column_name)
          .sort(),
        `nullable columns for ${table}`,
      ).toEqual(
        expectedColumns[table].filter((column) => !expectedNotNull[table].includes(column)).sort(),
      );
    }

    const types = new Map(
      columns.rows.map((row) => [`${row.table_name}.${row.column_name}`, row.udt_name]),
    );
    expect(types.get('users.email')).toBe('citext');
    expect(types.get('organizations.currency')).toBe('bpchar');
    expect(types.get('branches.country')).toBe('bpchar');
    expect(types.get('sessions.token_hash')).toBe('bytea');
    expect(types.get('sessions.ip')).toBe('inet');
    expect(types.get('audit_logs.id')).toBe('int8');
    expect(types.get('audit_logs.metadata')).toBe('jsonb');
    expect(types.get('audit_logs.actor_roles')).toBe('_text');
  });

  it('declares the approved composite foreign keys and invitation boundary', async () => {
    const constraints = await harness.adminPool.query<{
      table_name: string;
      definition: string;
    }>(
      `SELECT relation.relname AS table_name, pg_get_constraintdef(constraint_row.oid) AS definition
         FROM pg_constraint AS constraint_row
         JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
         JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname IN ('staff_role_assignments', 'invitations')
          AND constraint_row.contype = 'f'`,
    );

    const staffKeys = constraints.rows
      .filter((row) => row.table_name === 'staff_role_assignments')
      .map((row) => row.definition.toLowerCase().replace(/\s+/g, ' '));
    expect(staffKeys.some((key) => key.includes('(organization_id, user_id)'))).toBe(true);
    expect(staffKeys.some((key) => key.includes('on delete cascade'))).toBe(true);
    expect(staffKeys.some((key) => key.includes('(organization_id, branch_id)'))).toBe(true);

    const invitationKeys = constraints.rows.filter((row) => row.table_name === 'invitations');
    expect(invitationKeys).toHaveLength(3);
    expect(
      invitationKeys.some((row) =>
        row.definition.toLowerCase().replace(/\s+/g, ' ').includes('(organization_id, branch_id)'),
      ),
    ).toBe(true);

    const staging = await harness.adminPool.query<{
      patient_table: string | null;
      invitation_role_check: string | null;
      patient_id_nullable: string;
    }>(`
      SELECT to_regclass('public.patients')::text AS patient_table,
             (SELECT pg_get_constraintdef(c.oid)
                FROM pg_constraint c
               WHERE c.conrelid = 'public.invitations'::regclass
                 AND c.conname = 'invitations_role_check') AS invitation_role_check,
             (SELECT is_nullable FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'invitations'
                 AND column_name = 'patient_id') AS patient_id_nullable
    `);
    expect(staging.rows[0]?.patient_table).toBeNull();
    expect(staging.rows[0]?.patient_id_nullable).toBe('YES');
    expect(staging.rows[0]?.invitation_role_check).not.toContain("'patient'");
  });

  it('has RLS enabled and forced on every M1-A tenant table and absent on global tables', async () => {
    const state = await harness.adminPool.query<{
      tablename: string;
      rowsecurity: boolean;
      forcerowsecurity: boolean;
    }>(
      `SELECT relname AS tablename, relrowsecurity AS rowsecurity,
              relforcerowsecurity AS forcerowsecurity
         FROM pg_class
         JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
        WHERE nspname = 'public' AND relname = ANY($1) AND relkind = 'r'
        ORDER BY relname`,
      [[...m1aTables]],
    );
    const byTable = new Map(state.rows.map((row) => [row.tablename, row]));

    for (const table of tenantTables) {
      expect(byTable.get(table)?.rowsecurity, `${table} RLS enabled`).toBe(true);
      expect(byTable.get(table)?.forcerowsecurity, `${table} FORCE RLS`).toBe(true);
    }
    for (const table of nonTenantM1aTables) {
      expect(byTable.get(table)?.rowsecurity, `${table} must not use tenant RLS`).toBe(false);
    }
  });

  it('returns no rows for every tenant table without context and rejects context-free inserts', async () => {
    for (const table of [
      'branches',
      'organization_members',
      'staff_role_assignments',
      'invitations',
      'tenant_counters',
      'audit_logs',
    ] as const) {
      const result = await harness.appPool.query(`SELECT 1 FROM ${table} LIMIT 1`);
      expect(result.rowCount, `${table} without context`).toBe(0);
    }

    await expectSqlState(
      harness.appPool.query(
        `INSERT INTO organization_members (organization_id, user_id) VALUES ($1, $2)`,
        [organizationA, userOther],
      ),
      ['42501'],
    );
    await expectSqlState(
      harness.appPool.query(
        `INSERT INTO staff_role_assignments (organization_id, user_id, role, branch_id)
         VALUES ($1, $2, 'receptionist', $3)`,
        [organizationA, userOther, branchA],
      ),
      ['42501'],
    );
    await expectSqlState(
      harness.appPool.query(
        `INSERT INTO audit_logs (organization_id, actor_type, action, resource_type, outcome)
         VALUES ($1, 'system', 'test.noctx', 'test', 'success')`,
        [organizationA],
      ),
      ['42501'],
    );
    await harness.appPool.query(
      `INSERT INTO audit_logs (organization_id, actor_type, action, resource_type, outcome)
       VALUES (NULL, 'system', 'test.platform_noctx', 'test', 'success')`,
    );
  });

  it('applies the membership lookup policy without leaking other users across orgs', async () => {
    const orgOnly = await withTenantTransaction(
      appDatabase,
      { orgId: organizationA },
      async (tx) => {
        const members = await tx.execute(
          sql`SELECT organization_id, user_id FROM organization_members ORDER BY user_id`,
        );
        const roles = await tx.execute(
          sql`SELECT organization_id, user_id, role FROM staff_role_assignments ORDER BY user_id, role`,
        );
        return { members: members.rows, roles: roles.rows };
      },
    );
    expect(orgOnly.members).toEqual([
      { organization_id: organizationA, user_id: userA },
      { organization_id: organizationA, user_id: userOther },
    ]);
    expect(orgOnly.roles).toEqual([
      { organization_id: organizationA, user_id: userA, role: 'doctor' },
      { organization_id: organizationA, user_id: userOther, role: 'receptionist' },
    ]);

    const ownMembership = await withTenantTransaction(
      appDatabase,
      { orgId: organizationA, userId: userA },
      async (tx) => {
        const members = await tx.execute(
          sql`SELECT organization_id, user_id FROM organization_members ORDER BY organization_id`,
        );
        const roles = await tx.execute(
          sql`SELECT organization_id, role FROM staff_role_assignments ORDER BY organization_id`,
        );
        return { members: members.rows, roles: roles.rows };
      },
    );
    expect(ownMembership.members).toEqual([
      { organization_id: organizationA, user_id: userA },
      { organization_id: organizationA, user_id: userOther },
      { organization_id: organizationB, user_id: userA },
    ]);
    expect(ownMembership.roles).toEqual([
      { organization_id: organizationA, role: 'doctor' },
      { organization_id: organizationA, role: 'receptionist' },
      { organization_id: organizationB, role: 'org_owner' },
    ]);

    const otherUser = await withTenantTransaction(
      appDatabase,
      { orgId: organizationA, userId: userOther },
      async (tx) => {
        const members = await tx.execute(
          sql`SELECT organization_id, user_id FROM organization_members ORDER BY organization_id`,
        );
        const roles = await tx.execute(
          sql`SELECT organization_id, role FROM staff_role_assignments ORDER BY organization_id`,
        );
        return { members: members.rows, roles: roles.rows };
      },
    );
    expect(otherUser.members).toEqual([
      { organization_id: organizationA, user_id: userA },
      { organization_id: organizationA, user_id: userOther },
    ]);
    expect(otherUser.roles).toEqual([
      { organization_id: organizationA, role: 'doctor' },
      { organization_id: organizationA, role: 'receptionist' },
    ]);
  });

  it('rejects cross-tenant role and invitation references through composite FKs', async () => {
    await expectSqlState(
      withTenantTransaction(appDatabase, { orgId: organizationA }, (tx) =>
        tx.execute(sql`
          INSERT INTO staff_role_assignments (organization_id, user_id, role, branch_id)
          VALUES (${organizationA}, ${userOther}, 'doctor', ${branchB})
        `),
      ),
      ['23503'],
    );
    await expectSqlState(
      withTenantTransaction(appDatabase, { orgId: organizationA }, (tx) =>
        tx.execute(sql`
          INSERT INTO invitations
            (organization_id, email, role, branch_id, token_hash, invited_by, expires_at)
          VALUES
            (${organizationA}, 'cross-branch@example.test', 'doctor', ${branchB},
             ${Buffer.from('cross-branch')}, ${userA}, now() + interval '1 day')
        `),
      ),
      ['23503'],
    );

    const ownBranchRole = await withTenantTransaction(appDatabase, { orgId: organizationA }, (tx) =>
      tx.execute(sql`
          INSERT INTO staff_role_assignments (organization_id, user_id, role, branch_id)
          VALUES (${organizationA}, ${userOther}, 'doctor', ${branchA})
        `),
    );
    expect(ownBranchRole.rowCount).toBe(1);
  });

  it('keeps clinic_app to the intended effective privileges', async () => {
    const privileges = await effectivePrivileges('clinic_app', m1aTables);
    for (const table of m1aTables.filter((table) => table !== 'audit_logs')) {
      expect(privileges[table], `${table} privileges`).toEqual({
        select: true,
        insert: true,
        update: true,
        delete: true,
      });
    }
    expect(privileges.audit_logs).toEqual({
      select: true,
      insert: true,
      update: false,
      delete: false,
    });

    const membership = await harness.adminPool.query<{
      app_in_migrator: boolean;
      worker_in_migrator: boolean;
    }>(`
      SELECT pg_has_role('clinic_app', 'clinic_migrator', 'MEMBER') AS app_in_migrator,
             pg_has_role('clinic_worker', 'clinic_migrator', 'MEMBER') AS worker_in_migrator
    `);
    expect(membership.rows[0]).toEqual({ app_in_migrator: false, worker_in_migrator: false });
  });

  it('keeps clinic_worker to its documented grants and denies writes it must not perform', async () => {
    const privileges = await effectivePrivileges('clinic_worker', m1aTables);
    expect(privileges.branches).toEqual({
      select: true,
      insert: false,
      update: false,
      delete: false,
    });
    expect(privileges.tenant_counters).toEqual({
      select: true,
      insert: true,
      update: true,
      delete: false,
    });
    expect(privileges.audit_logs).toEqual({
      select: true,
      insert: true,
      update: false,
      delete: false,
    });
    for (const table of [
      'users',
      'sessions',
      'auth_tokens',
      'organizations',
      'organization_members',
      'staff_role_assignments',
      'invitations',
    ] as const) {
      expect(privileges[table], `${table} must be denied to clinic_worker`).toEqual({
        select: false,
        insert: false,
        update: false,
        delete: false,
      });
    }

    for (const table of [
      'users',
      'sessions',
      'auth_tokens',
      'organizations',
      'organization_members',
      'staff_role_assignments',
      'invitations',
    ] as const) {
      await expectSqlState(harness.workerPool.query(`SELECT 1 FROM ${table} LIMIT 1`), ['42501']);
    }
    await expectSqlState(
      harness.workerPool.query(
        `INSERT INTO branches (organization_id, name, code, timezone) VALUES ($1, 'W', 'WX', 'UTC')`,
        [organizationA],
      ),
      ['42501'],
    );
    await expectSqlState(
      harness.workerPool.query(`UPDATE branches SET name = 'W' WHERE id = $1`, [branchA]),
      ['42501'],
    );
    await expectSqlState(
      harness.workerPool.query(`DELETE FROM branches WHERE id = $1`, [branchA]),
      ['42501'],
    );
    await expectSqlState(
      harness.workerPool.query(`DELETE FROM tenant_counters WHERE organization_id = $1`, [
        organizationA,
      ]),
      ['42501'],
    );
    await expectSqlState(harness.workerPool.query(`UPDATE audit_logs SET action = 'tampered'`), [
      '42501',
    ]);
    await expectSqlState(harness.workerPool.query(`DELETE FROM audit_logs`), ['42501']);
    await expectSqlState(harness.workerPool.query(`TRUNCATE audit_logs`), ['42501']);
  });

  it('enforces the T1 trigger on every M1-A table that has updated_at', async () => {
    const triggers = await harness.adminPool.query<{ tablename: string; tgname: string }>(
      `SELECT relation.relname AS tablename, trigger.tgname
         FROM pg_trigger trigger
         JOIN pg_class relation ON relation.oid = trigger.tgrelid
         JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname = ANY($1)
          AND NOT trigger.tgisinternal
          AND trigger.tgname = relation.relname || '_set_updated_at'
        ORDER BY relation.relname`,
      [['users', 'organizations', 'branches']],
    );
    expect(triggers.rows.map((row) => row.tgname)).toEqual([
      'branches_set_updated_at',
      'organizations_set_updated_at',
      'users_set_updated_at',
    ]);

    const before = await harness.adminPool.query<{
      table_name: string;
      updated_at: Date;
      touched: Date;
    }>(`
      SELECT 'users' AS table_name, updated_at, last_login_at AS touched FROM users WHERE id = '${userA}'
      UNION ALL
      SELECT 'organizations', updated_at, NULL FROM organizations WHERE id = '${organizationA}'
      UNION ALL
      SELECT 'branches', updated_at, NULL FROM branches WHERE id = '${branchA}'
    `);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));

    await harness.adminPool.query('UPDATE users SET updated_at = updated_at WHERE id = $1', [
      userA,
    ]);
    await harness.adminPool.query(
      'UPDATE organizations SET updated_at = updated_at WHERE id = $1',
      [organizationA],
    );
    await withTenantTransaction(appDatabase, { orgId: organizationA }, (tx) =>
      tx.execute(sql`UPDATE branches SET updated_at = updated_at WHERE id = ${branchA}`),
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
      expect(row.updated_at.getTime(), `${row.table_name} updated_at`).toBeGreaterThan(
        beforeByTable.get(row.table_name) ?? 0,
      );
    }
  });

  it('rejects every non-staff invitation shape and accepts each staff role', async () => {
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
            (${organizationA}, ${`staff-${index}@example.test`}, ${role}, ${branchId},
             ${Buffer.from(`staff-${index}`)}, ${userA}, now() + interval '1 day')
        `);
      }
    });

    await expectSqlState(
      withTenantTransaction(appDatabase, { orgId: organizationA }, (tx) =>
        tx.execute(sql`
          INSERT INTO invitations
            (organization_id, email, role, token_hash, invited_by, expires_at)
          VALUES
            (${organizationA}, 'patient@example.test', 'patient',
             ${Buffer.from('patient-role')}, ${userA}, now() + interval '1 day')
        `),
      ),
      ['23514'],
    );
    await expectSqlState(
      withTenantTransaction(appDatabase, { orgId: organizationA }, (tx) =>
        tx.execute(sql`
          INSERT INTO invitations
            (organization_id, email, role, branch_id, patient_id, token_hash, invited_by, expires_at)
          VALUES
            (${organizationA}, 'staff-with-patient@example.test', 'doctor', ${branchA},
             ${'40000000-0000-0000-0000-000000000001'}, ${Buffer.from('staff-with-patient')},
             ${userA}, now() + interval '1 day')
        `),
      ),
      ['23514'],
    );
    await expectSqlState(
      withTenantTransaction(appDatabase, { orgId: organizationA }, (tx) =>
        tx.execute(sql`
          INSERT INTO invitations
            (organization_id, email, role, token_hash, invited_by, expires_at)
          VALUES
            (${organizationA}, 'branchless-doctor@example.test', 'doctor',
             ${Buffer.from('branchless-doctor')}, ${userA}, now() + interval '1 day')
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
            (${organizationA}, 'owner-with-branch@example.test', 'org_owner', ${branchA},
             ${Buffer.from('owner-with-branch')}, ${userA}, now() + interval '1 day')
        `),
      ),
      ['23514'],
    );
  });

  it('keeps audit_logs readable only inside the current organization', async () => {
    const orgA = await withTenantTransaction(appDatabase, { orgId: organizationA }, (tx) =>
      tx.execute(sql`SELECT action FROM audit_logs ORDER BY action`),
    );
    expect(orgA.rows).toEqual([{ action: 'test.org_a' }]);

    const noContext = await harness.appPool.query('SELECT action FROM audit_logs');
    expect(noContext.rowCount).toBe(0);

    const orgB = await withTenantTransaction(appDatabase, { orgId: organizationB }, (tx) =>
      tx.execute(sql`SELECT action FROM audit_logs ORDER BY action`),
    );
    expect(orgB.rows).toEqual([{ action: 'test.org_b' }]);

    const platformRows = await withTenantTransaction(appDatabase, { orgId: organizationA }, (tx) =>
      tx.execute(sql`SELECT action FROM audit_logs WHERE organization_id IS NULL`),
    );
    expect(platformRows.rowCount).toBe(0);
  });
});
