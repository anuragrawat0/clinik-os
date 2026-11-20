import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { PgBoss, type Job } from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runInTenant } from '../../src/core/jobs/run-in-tenant';
import { InvalidTenantContextError } from '../../src/core/db/transaction-context';
import { findRuntimeRoleViolations, readRuntimeRoleState } from '../../src/core/db/role-self-check';
import {
  type DatabaseHarness,
  organizationA,
  organizationB,
  startDatabaseHarness,
  tenantRows,
} from './harness';

interface TenantJobData {
  orgId: string;
  entityIds: number[];
}

const queueName = 'tenant-isolation-test';

let harness: DatabaseHarness;
let boss: PgBoss;
let workerDatabase: ReturnType<typeof drizzle>;

async function fetchOne(): Promise<Job<TenantJobData>> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const jobs = await boss.fetch<TenantJobData>(queueName);
    if (jobs.length > 0) {
      return jobs[0];
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error('pg-boss did not return the queued test job.');
}

describe('clinic_worker pg-boss isolation', () => {
  beforeAll(async () => {
    harness = await startDatabaseHarness();
    workerDatabase = drizzle(harness.workerPool);

    boss = new PgBoss({
      connectionString: harness.connectionString('clinic_worker'),
      schema: 'pgboss',
      createSchema: false,
      instanceName: 'clinik-test-worker',
      max: 2,
      supervise: false,
      schedule: false,
    });
    boss.on('error', () => undefined);
    await boss.start();
    await boss.createQueue(queueName);
  }, 180_000);

  afterAll(async () => {
    await boss?.stop();
    await harness?.stop();
  });

  beforeEach(async () => {
    await harness.resetTenantRows();
    await boss.deleteAllJobs(queueName);
  });

  it('starts pg-boss as clinic_worker without needing public ownership', async () => {
    const queue = await boss.getQueue(queueName);
    expect(queue?.name).toBe(queueName);

    const state = await readRuntimeRoleState(harness.workerPool);
    expect(state.ownedPublicRelations).toBe(0);
    expect(findRuntimeRoleViolations(state, 'clinic_worker')).toEqual([]);
  });

  it('runs a queued job through runInTenant with only its organization rows', async () => {
    await boss.send(queueName, { orgId: organizationA, entityIds: [1] });
    const job = await fetchOne();

    const result = await runInTenant(workerDatabase, job.data.orgId, async (tx) => {
      const context = await tx.execute(sql`SELECT public.app_current_org() AS org_id`);
      const rows = await tx.execute(
        sql`SELECT id, organization_id FROM test_tenant_rows ORDER BY id`,
      );
      return { context: context.rows[0]?.org_id, rows: rows.rows };
    });

    expect(result.context).toBe(organizationA);
    expect(result.rows).toEqual([{ id: 1, organization_id: organizationA }]);
    await boss.complete(queueName, job.id);
  });

  it("does not let a job for one organization read another organization's rows", async () => {
    await boss.send(queueName, { orgId: organizationA, entityIds: [2] });
    const job = await fetchOne();

    const result = await runInTenant(workerDatabase, job.data.orgId, async (tx) => {
      const rows = await tx.execute(
        sql`SELECT id FROM test_tenant_rows WHERE id = ${job.data.entityIds[0]}`,
      );
      return rows.rows;
    });

    expect(result).toEqual([]);
    await boss.complete(queueName, job.id);
  });

  it('rejects malformed organization ids before starting a transaction', async () => {
    await expect(
      runInTenant(workerDatabase, 'not-a-uuid', async () => undefined),
    ).rejects.toBeInstanceOf(InvalidTenantContextError);

    await expect(
      runInTenant(workerDatabase, `${organizationB}' OR 1=1 --`, async () => undefined),
    ).rejects.toBeInstanceOf(InvalidTenantContextError);

    const context = await harness.workerPool.query<{ org_id: string | null }>(
      'SELECT public.app_current_org() AS org_id',
    );
    expect(context.rows[0]?.org_id).toBeNull();
  });

  it('leaves no tenant context on the pooled connection for the next job', async () => {
    await boss.send(queueName, { orgId: organizationB, entityIds: [2] });
    const job = await fetchOne();

    await runInTenant(workerDatabase, job.data.orgId, async (tx) => {
      await tx.execute(sql`SELECT count(*) FROM test_tenant_rows`);
    });
    await boss.complete(queueName, job.id);

    const leaked = await harness.workerPool.query<{ org_id: string | null }>(
      'SELECT public.app_current_org() AS org_id',
    );
    expect(leaked.rows[0]?.org_id).toBeNull();

    const visible = await harness.workerPool.query(`SELECT id FROM ${tenantRows}`);
    expect(visible.rowCount).toBe(0);
  });
});
