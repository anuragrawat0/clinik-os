import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTransaction } from '../../src/core/db/transaction-context';
import { assertExpectedSqlState } from '../../src/core/db/trigger-test-helper';
import { type DatabaseHarness, organizationA, startDatabaseHarness } from './harness';
import { findMissingUpdatedAtTriggers, findTenantRlsViolations } from './schema-invariants';

const draftNote = 'aaaaaaaa-0000-0000-0000-000000000001';
const deletedDraft = 'aaaaaaaa-0000-0000-0000-000000000003';

/**
 * M0 port of the M0-relevant checks from database/tests/smoke2.sql.
 *
 * The legacy suite's business-table checks (T3-T14, W3-W11, appointment,
 * payment, video, notification and idempotency cases) are intentionally not
 * ported here: those tables and triggers are M1-M5 scope and do not exist in
 * the M0 schema. Shared trigger helpers, T1, the tenant RLS invariant, role
 * isolation and the role bootstrap are covered by this file and the sibling
 * database specs.
 */

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

describe('shared database helpers and schema invariants', () => {
  beforeAll(async () => {
    harness = await startDatabaseHarness();
    appDatabase = drizzle(harness.appPool);

    await harness.migratorPool.query(`
      CREATE SCHEMA rls_test;

      -- A tenant table created without the RLS convention: the invariant must catch this.
      CREATE TABLE rls_test.unprotected_tenant (
        id integer PRIMARY KEY,
        organization_id uuid NOT NULL
      );

      -- Allow-listed non-tenant system table from DATABASE_DESIGN §11.2.
      CREATE TABLE rls_test.stripe_webhook_events (
        id integer PRIMARY KEY,
        organization_id uuid
      );

      CREATE TABLE rls_test.frozen_fixture (
        id uuid PRIMARY KEY,
        status text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TRIGGER frozen_fixture_immutable BEFORE UPDATE OR DELETE ON rls_test.frozen_fixture
        FOR EACH ROW EXECUTE FUNCTION forbid_change_when_frozen('old.status = ''signed''');

      CREATE TABLE rls_test.append_only_fixture (
        id integer PRIMARY KEY,
        body text NOT NULL
      );
      CREATE TRIGGER append_only_fixture_mutation BEFORE UPDATE OR DELETE ON rls_test.append_only_fixture
        FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

      CREATE TABLE rls_test.no_delete_fixture (
        id integer PRIMARY KEY,
        status text NOT NULL
      );
      CREATE TRIGGER no_delete_fixture_delete BEFORE DELETE ON rls_test.no_delete_fixture
        FOR EACH ROW EXECUTE FUNCTION forbid_delete();

      CREATE TABLE rls_test.t1_fixture (
        id integer PRIMARY KEY,
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE rls_test.missing_updated_at_with_column (
        id integer PRIMARY KEY,
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE rls_test.missing_updated_at (id integer PRIMARY KEY);
    `);
  }, 120_000);

  afterAll(async () => {
    await harness?.stop();
  });

  afterEach(async () => {
    await harness.migratorPool.query(
      'TRUNCATE rls_test.frozen_fixture, rls_test.append_only_fixture, rls_test.no_delete_fixture',
    );
  });

  it('detects tenant tables missing RLS, FORCE RLS or a policy', async () => {
    const before = await findTenantRlsViolations(harness.adminPool, 'rls_test');
    expect(before).toContainEqual({
      schema: 'rls_test',
      table: 'unprotected_tenant',
      reason: 'rls_disabled',
    });
    expect(before.some((violation) => violation.table === 'stripe_webhook_events')).toBe(false);

    await harness.migratorPool.query(
      `SELECT public.attach_tenant_rls('rls_test.unprotected_tenant'::regclass)`,
    );
    const afterAttach = await findTenantRlsViolations(harness.adminPool, 'rls_test');
    expect(afterAttach.some((violation) => violation.table === 'unprotected_tenant')).toBe(false);

    await harness.migratorPool.query(
      'ALTER TABLE rls_test.unprotected_tenant NO FORCE ROW LEVEL SECURITY',
    );
    const withoutForce = await findTenantRlsViolations(harness.adminPool, 'rls_test');
    expect(withoutForce).toContainEqual({
      schema: 'rls_test',
      table: 'unprotected_tenant',
      reason: 'force_rls_disabled',
    });

    await harness.migratorPool.query(
      'ALTER TABLE rls_test.unprotected_tenant FORCE ROW LEVEL SECURITY',
    );
    await harness.migratorPool.query('DROP POLICY tenant_isolation ON rls_test.unprotected_tenant');
    const withoutPolicy = await findTenantRlsViolations(harness.adminPool, 'rls_test');
    expect(withoutPolicy).toContainEqual({
      schema: 'rls_test',
      table: 'unprotected_tenant',
      reason: 'missing_policy',
    });
  });

  it('passes the tenant RLS invariant for the migrated public schema', async () => {
    const violations = await findTenantRlsViolations(harness.adminPool, 'public');
    expect(violations).toEqual([]);
  });

  it('detects tables with updated_at but no set_updated_at trigger (T1)', async () => {
    const before = await findMissingUpdatedAtTriggers(harness.adminPool, 'rls_test');
    expect(before).toContainEqual({
      schema: 'rls_test',
      table: 'missing_updated_at_with_column',
    });

    await harness.migratorPool.query(
      `SELECT public.attach_set_updated_at('rls_test.missing_updated_at_with_column'::regclass)`,
    );
    const after = await findMissingUpdatedAtTriggers(harness.adminPool, 'rls_test');
    expect(after.some((violation) => violation.table === 'missing_updated_at_with_column')).toBe(
      false,
    );
  });

  it('attaches set_updated_at idempotently and advances updated_at', async () => {
    await harness.migratorPool.query(
      `SELECT public.attach_set_updated_at('rls_test.t1_fixture'::regclass)`,
    );
    await harness.migratorPool.query(
      `SELECT public.attach_set_updated_at('rls_test.t1_fixture'::regclass)`,
    );
    await harness.migratorPool.query('INSERT INTO rls_test.t1_fixture (id) VALUES (1)');

    const before = await harness.migratorPool.query<{ updated_at: Date }>(
      'SELECT updated_at FROM rls_test.t1_fixture WHERE id = 1',
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    await harness.migratorPool.query('UPDATE rls_test.t1_fixture SET id = id WHERE id = 1');
    const after = await harness.migratorPool.query<{ updated_at: Date }>(
      'SELECT updated_at FROM rls_test.t1_fixture WHERE id = 1',
    );

    expect(after.rows[0]?.updated_at.getTime()).toBeGreaterThan(
      before.rows[0]?.updated_at.getTime(),
    );
    await harness.migratorPool.query('DELETE FROM rls_test.t1_fixture');
  });

  it('rejects attach helpers when the required column is missing', async () => {
    await expectSqlState(
      harness.migratorPool.query(
        `SELECT public.attach_set_updated_at('rls_test.missing_updated_at'::regclass)`,
      ),
      ['23514'],
    );
    await expectSqlState(
      harness.migratorPool.query(
        `SELECT public.attach_tenant_rls('rls_test.missing_updated_at'::regclass)`,
      ),
      ['23514'],
    );
  });

  it('forbids changes to a frozen row and allows draft updates', async () => {
    await harness.migratorPool.query(
      `INSERT INTO rls_test.frozen_fixture (id, status) VALUES ($1, 'draft')`,
      [draftNote],
    );
    await harness.migratorPool.query(
      `UPDATE rls_test.frozen_fixture SET status = 'draft' WHERE id = $1`,
      [draftNote],
    );
    await harness.migratorPool.query(
      `UPDATE rls_test.frozen_fixture SET status = 'signed' WHERE id = $1`,
      [draftNote],
    );

    await expectSqlState(
      harness.migratorPool.query(
        `UPDATE rls_test.frozen_fixture SET status = 'edited' WHERE id = $1`,
        [draftNote],
      ),
      ['23514'],
    );
    await expectSqlState(
      harness.migratorPool.query(`DELETE FROM rls_test.frozen_fixture WHERE id = $1`, [draftNote]),
      ['23514'],
    );

    await harness.migratorPool.query(
      `INSERT INTO rls_test.frozen_fixture (id, status) VALUES ($1, 'draft')`,
      [deletedDraft],
    );
    await harness.migratorPool.query(`DELETE FROM rls_test.frozen_fixture WHERE id = $1`, [
      deletedDraft,
    ]);
  });

  it('forbids any mutation of an append-only table', async () => {
    await harness.migratorPool.query(
      `INSERT INTO rls_test.append_only_fixture (id, body) VALUES (1, 'first')`,
    );
    await expectSqlState(
      harness.migratorPool.query(
        `UPDATE rls_test.append_only_fixture SET body = 'edited' WHERE id = 1`,
      ),
      ['23514'],
    );
    await expectSqlState(
      harness.migratorPool.query('DELETE FROM rls_test.append_only_fixture WHERE id = 1'),
      ['23514'],
    );
  });

  it('forbids deletes while allowing status updates on no-delete tables', async () => {
    await harness.migratorPool.query(
      `INSERT INTO rls_test.no_delete_fixture (id, status) VALUES (1, 'active')`,
    );
    await harness.migratorPool.query(
      `UPDATE rls_test.no_delete_fixture SET status = 'entered_in_error' WHERE id = 1`,
    );
    await expectSqlState(
      harness.migratorPool.query('DELETE FROM rls_test.no_delete_fixture WHERE id = 1'),
      ['23514'],
    );
  });

  it('maintains transaction-local app_current_org and app_current_user', async () => {
    const outside = await harness.appPool.query<{ org: string | null; user: string | null }>(
      'SELECT public.app_current_org() AS org, public.app_current_user() AS user',
    );
    expect(outside.rows[0]).toEqual({ org: null, user: null });

    const inside = await withTenantTransaction(
      appDatabase,
      { orgId: organizationA, userId: '10000000-0000-0000-0000-0000000000aa' },
      async (tx) => {
        const result = await tx.execute(
          sql`SELECT public.app_current_org() AS org, public.app_current_user() AS user`,
        );
        return result.rows[0];
      },
    );
    expect(inside).toEqual({
      org: organizationA,
      user: '10000000-0000-0000-0000-0000000000aa',
    });

    const afterCommit = await harness.appPool.query<{ org: string | null; user: string | null }>(
      'SELECT public.app_current_org() AS org, public.app_current_user() AS user',
    );
    expect(afterCommit.rows[0]).toEqual({ org: null, user: null });
  });
});
