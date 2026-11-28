import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import type { Permission, StaffRole } from '@clinik/shared';
import { Pool, type PoolClient } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditWriter } from '../../src/core/audit';
import { DATABASE, type DatabaseConnection } from '../../src/core/db/database.module';
import { logger } from '../../src/core/logging/logger';
import { PasswordService, SessionService, TokenService } from '../../src/modules/identity/core';
import { AUTH_MAIL_TRANSPORT } from '../../src/modules/notifications/auth-mailer';
import {
  type DatabaseHarness,
  organizationA,
  organizationB,
  startDatabaseHarness,
} from '../db/harness';
import { matrixScopesFor, matrixStaffRanks } from '../fixtures/rbac-matrix';
import {
  collectControllerRoutes,
  collectMountedRoutes,
  type ExpressLayer,
} from '../helpers/express-routes';

/**
 * Independent review tests for M1b slice 2 (tenancy, provisioning, access core).
 *
 * These tests exercise:
 *  - P1: Organization write locks are compatible with FK inserts and unrelated writes.
 *  - P2: the request transaction closes on every failure path.
 *  - P3: branch scope is enforced in services.
 *  - P5(b): ownership transfer reauthentication is tracked per session.
 *
 * Tests marked "EXPECTED DESIGN" fail against 41ec759 and should start passing after a fix.
 */

const branchA = '20000000-0000-0000-0000-000000000001';
const otherBranch = '20000000-0000-0000-0000-000000000002';
const foreignBranch = '20000000-0000-0000-0000-000000000003';
const orgPath = `/api/v1/orgs/${organizationA}`;
const password = 'Synthetic-staff-passphrase-27';
const fullName = 'Synthetic Reviewer';
const writeHeaders = {
  'X-Requested-With': 'XMLHttpRequest',
  'X-Request-Id': 'slice2-review',
};

const ownerRole = { role: 'org_owner', branchId: null } as const;
const adminRole = { role: 'org_admin', branchId: null } as const;
const managerRole = { role: 'branch_manager', branchId: branchA } as const;
const doctorA = { role: 'doctor', branchId: branchA } as const;
const doctorB = { role: 'doctor', branchId: otherBranch } as const;

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';

let harness: DatabaseHarness;
let app: INestApplication;
let document: OpenAPIObject;
let port: number;
let passwordHash: string;
let tokens: TokenService;
let superuser: Pool;
let usersCreated = 0;

function httpClient() {
  return request(app.getHttpServer());
}

function call(method: Method, path: string, cookie?: string) {
  const req = httpClient()[method](path).set(writeHeaders);
  return cookie ? req.set('Cookie', cookie) : req;
}

async function createUser(): Promise<{ id: string; email: string }> {
  const email = `synthetic.review.${++usersCreated}@clinik.test`;
  const result = await harness.adminPool.query<{ id: string }>(
    'INSERT INTO users (email, password_hash, full_name, status) VALUES ($1, $2, $3, $4) RETURNING id',
    [email, passwordHash, fullName, 'active'],
  );
  return { id: result.rows[0].id, email };
}

async function member(
  options: {
    orgId?: string;
    roles?: readonly { role: string; branchId: string | null }[];
    platform?: boolean;
  } = {},
) {
  const user = await createUser();
  if (options.platform)
    await harness.adminPool.query('UPDATE users SET is_platform_admin = true WHERE id = $1', [
      user.id,
    ]);
  if (options.orgId) {
    await harness.adminPool.query(
      'INSERT INTO organization_members (organization_id, user_id) VALUES ($1, $2)',
      [options.orgId, user.id],
    );
    for (const { role, branchId } of options.roles ?? []) {
      await harness.adminPool.query(
        'INSERT INTO staff_role_assignments (organization_id, user_id, role, branch_id) VALUES ($1, $2, $3, $4)',
        [options.orgId, user.id, role, branchId],
      );
    }
  }
  const { rawToken } = await app.get(SessionService).create(user.id, {
    ip: null,
    userAgent: null,
    requestId: null,
  });
  return { ...user, cookie: `__Host-session=${rawToken}` };
}

async function directInvitation(input: {
  orgId?: string;
  email: string;
  role: string;
  branchId: string | null;
  invitedBy: string;
  expiresAt?: Date;
}): Promise<{ id: string; path: string; rawToken: string }> {
  const token = tokens.generate();
  const result = await harness.adminPool.query<{ id: string }>(
    `INSERT INTO invitations (organization_id, email, role, branch_id, token_hash, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      input.orgId ?? organizationA,
      input.email,
      input.role,
      input.branchId,
      token.hash,
      input.invitedBy,
      input.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
    ],
  );
  return {
    id: result.rows[0].id,
    path: `/api/v1/auth/invitations/${input.orgId ?? organizationA}.${token.raw}`,
    rawToken: token.raw,
  };
}

async function pidsBlockedBy(blockerPid: number): Promise<number[]> {
  const { rows } = await harness.adminPool.query<{ pid: number }>(
    `SELECT pid FROM pg_stat_activity
     WHERE application_name = 'clinik-api' AND $1 = ANY(pg_blocking_pids(pid))`,
    [blockerPid],
  );
  return rows.map(({ pid }) => pid);
}

async function waitForBlockedBy(blockerPid: number): Promise<number> {
  return vi.waitFor(
    async () => {
      const pids = await pidsBlockedBy(blockerPid);
      expect(pids).toHaveLength(1);
      return pids[0];
    },
    { timeout: 10_000, interval: 25 },
  );
}

async function beginAuditHold(): Promise<{ gate: PoolClient; gatePid: number }> {
  const gate = await harness.adminPool.connect();
  await gate.query('BEGIN');
  await gate.query('LOCK TABLE audit_logs IN ACCESS EXCLUSIVE MODE');
  const { rows } = await gate.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  return { gate, gatePid: rows[0].pid };
}

async function releaseHold(gate: PoolClient): Promise<void> {
  try {
    await gate.query('ROLLBACK');
  } finally {
    gate.release();
  }
}

async function idleInTransaction(): Promise<number> {
  const { rows } = await harness.adminPool.query<{ count: number }>(
    `SELECT count(*)::integer AS count FROM pg_stat_activity
     WHERE application_name = 'clinik-api' AND state IN ('idle in transaction', 'idle in transaction (aborted)')`,
  );
  return rows[0].count;
}

async function auditRowsForOrg() {
  const { rows } = await harness.adminPool.query(
    `SELECT action, organization_id, metadata, changed_fields FROM audit_logs
     WHERE organization_id IS NOT NULL ORDER BY id`,
  );
  return rows;
}

function deferredSignal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeAll(async () => {
  harness = await startDatabaseHarness();
  vi.stubEnv('DATABASE_URL', harness.connectionString('clinic_app'));
  vi.stubEnv('TRUSTED_PROXY_CIDRS', '');
  const { AppModule } = await import('../../src/app.module');
  const { configureHttpApp } = await import('../../src/http-app');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(AUTH_MAIL_TRANSPORT)
    .useValue({ sendMail: async () => undefined })
    .compile();
  app = moduleRef.createNestApplication();
  document = configureHttpApp(app);
  await app.init();
  await app.listen(0);
  port = (app.getHttpServer().address() as AddressInfo).port;
  passwordHash = await app.get(PasswordService).hash(password);
  tokens = app.get(TokenService);
  superuser = new Pool({ connectionString: harness.container.getConnectionUri(), max: 2 });
}, 180_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await superuser?.end();
  await app?.close();
  await harness?.stop();
});

beforeEach(async () => {
  await harness.adminPool.query('TRUNCATE users, organizations, audit_logs CASCADE');
  await harness.adminPool.query(
    `INSERT INTO organizations (id, name, slug) VALUES
       ($1, 'Clinic A', 'clinic-a'), ($2, 'Clinic B', 'clinic-b')`,
    [organizationA, organizationB],
  );
  await harness.adminPool.query(
    `INSERT INTO branches (id, organization_id, name, code, timezone) VALUES
       ($1, $3, 'Main Branch', 'MAIN', 'UTC'),
       ($2, $3, 'North Branch', 'NORTH', 'UTC'),
       ($4, $5, 'Foreign Branch', 'FOREIGN', 'UTC')`,
    [branchA, otherBranch, organizationA, foreignBranch, organizationB],
  );
});

describe('P1: organization locking', () => {
  it('an unrelated FK insert must not block while a role write holds the organization lock', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const target = await member({ orgId: organizationA });
    const { gate, gatePid } = await beginAuditHold();
    const first = call('put', `${orgPath}/members/${target.id}/roles`, owner.cookie).send({
      roles: [doctorA],
    });
    first.catch(() => undefined);
    const fk = await superuser.connect();
    try {
      await waitForBlockedBy(gatePid);
      await fk.query('BEGIN');
      await fk.query("SET LOCAL lock_timeout = '750ms'");
      const inserted = await fk.query(
        `INSERT INTO branches (organization_id, name, code, timezone)
         VALUES ($1, 'Inserted while locked', 'LOCKED', 'UTC')`,
        [organizationA],
      );
      expect(inserted.rowCount).toBe(1);
    } finally {
      await fk.query('ROLLBACK').catch(() => undefined);
      fk.release();
      await releaseHold(gate);
      await first;
    }
    expect((await first).status).toBe(204);
  }, 30_000);

  it('two unrelated tenant writes in one org must not serialize', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const { gate, gatePid } = await beginAuditHold();
    const first = call('patch', orgPath, owner.cookie).send({ name: 'First write' });
    first.catch(() => undefined);
    const second = call('post', `${orgPath}/branches`, owner.cookie).send({
      name: 'Second branch',
      code: `SECOND${randomBytes(3).toString('hex').toUpperCase()}`,
      timezone: 'UTC',
    });
    second.catch(() => undefined);
    try {
      await vi.waitFor(async () => expect(await pidsBlockedBy(gatePid)).toHaveLength(2), {
        timeout: 10_000,
        interval: 25,
      });
    } finally {
      await releaseHold(gate);
    }
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(201);
  }, 30_000);

  it('EXPECTED DESIGN: an FK insert must not block behind an organization settings update', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const { gate, gatePid } = await beginAuditHold();
    const first = call('patch', orgPath, owner.cookie).send({ name: 'Locked write' });
    first.catch(() => undefined);
    const fk = await superuser.connect();
    let code: string | undefined;
    try {
      await waitForBlockedBy(gatePid);
      await fk.query('BEGIN');
      await fk.query("SET LOCAL lock_timeout = '750ms'");
      try {
        await fk.query(
          `INSERT INTO branches (organization_id, name, code, timezone)
           VALUES ($1, 'Expected design insert', 'EXPECTED', 'UTC')`,
          [organizationA],
        );
      } catch (error) {
        code = (error as { code?: string }).code;
      } finally {
        await fk.query('ROLLBACK').catch(() => undefined);
      }
    } finally {
      fk.release();
      await releaseHold(gate);
      await first;
    }
    // FOR NO KEY UPDATE (expected) does not conflict with the FK's FOR KEY SHARE.
    expect(code).toBeUndefined();
  }, 30_000);

  it.each([
    { change: 'suspension', expected: 404 },
    { change: 'role removal', expected: 403 },
  ])(
    'rechecks actor access after waiting for concurrent $change',
    async ({ change, expected }) => {
      const admin = await member({ orgId: organizationA, roles: [adminRole] });
      const target = await member({ orgId: organizationA });
      const gate = await harness.adminPool.connect();
      try {
        await gate.query('BEGIN');
        await gate.query('SELECT id FROM organizations WHERE id = $1 FOR NO KEY UPDATE', [
          organizationA,
        ]);
        const {
          rows: [gateInfo],
        } = await gate.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        const update = Promise.resolve(
          call('put', `${orgPath}/members/${target.id}/roles`, admin.cookie).send({
            roles: [doctorA],
          }),
        );
        void update.catch(() => undefined);
        try {
          await waitForBlockedBy(gateInfo.pid);
          if (change === 'suspension') {
            await gate.query(
              "UPDATE organization_members SET status = 'suspended' WHERE organization_id = $1 AND user_id = $2",
              [organizationA, admin.id],
            );
          }
          await gate.query(
            'DELETE FROM staff_role_assignments WHERE organization_id = $1 AND user_id = $2',
            [organizationA, admin.id],
          );
          await gate.query('COMMIT');
          expect((await update).status).toBe(expected);
        } finally {
          await gate.query('ROLLBACK');
          await update.catch(() => undefined);
        }
      } finally {
        gate.release();
      }
      expect(await auditRowsForOrg()).toEqual([]);
    },
    30_000,
  );
});

describe('P2: the request transaction closes on every path', () => {
  it('releases the transaction after a zod 400 burst, a permission 403 burst and a handler conflict', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const doctor = await member({ orgId: organizationA, roles: [doctorA] });

    const invalid = await Promise.all(
      Array.from({ length: 15 }, () => call('patch', orgPath, owner.cookie).send({})),
    );
    expect(invalid.map(({ status }) => status)).toEqual(Array(15).fill(400));

    const forbidden = await Promise.all(
      Array.from({ length: 15 }, () =>
        call('post', `${orgPath}/branches`, doctor.cookie).send({
          name: 'Forbidden branch',
          code: 'FORBIDDEN',
          timezone: 'UTC',
        }),
      ),
    );
    expect(forbidden.map(({ status }) => status)).toEqual(Array(15).fill(403));

    const conflicts = await Promise.all(
      Array.from({ length: 10 }, () =>
        call('post', `${orgPath}/branches`, owner.cookie).send({
          name: 'Duplicate',
          code: 'MAIN',
          timezone: 'UTC',
        }),
      ),
    );
    expect(conflicts.map(({ status }) => status)).toEqual(Array(10).fill(409));

    const started = Date.now();
    await call('get', orgPath, owner.cookie).timeout({ response: 2000 }).expect(200);
    expect(Date.now() - started).toBeLessThan(2000);
    await vi.waitFor(async () => expect(await idleInTransaction()).toBe(0), { timeout: 5_000 });
  }, 60_000);

  it('closes the transaction when the client aborts a held request', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const { gate, gatePid } = await beginAuditHold();
    const body = JSON.stringify({ name: 'Aborted write' });
    const aborted = http.request({
      host: '127.0.0.1',
      port,
      path: `${orgPath}`,
      method: 'PATCH',
      headers: {
        ...writeHeaders,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Cookie: owner.cookie,
      },
    });
    aborted.on('error', () => undefined);
    try {
      aborted.write(body);
      aborted.end();
      await waitForBlockedBy(gatePid);
      aborted.destroy();
    } finally {
      await releaseHold(gate);
    }
    await vi.waitFor(async () => expect(await idleInTransaction()).toBe(0), { timeout: 10_000 });
    const started = Date.now();
    await call('get', orgPath, owner.cookie).timeout({ response: 2000 }).expect(200);
    expect(Date.now() - started).toBeLessThan(2000);
  }, 30_000);
});

describe('P3: branch scope', () => {
  it('enforces branch scope on invite, revoke, branch PATCH, member list, roles and removal', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const manager = await member({ orgId: organizationA, roles: [managerRole] });
    const branchBMember = await member({ orgId: organizationA, roles: [doctorB] });
    const target = await member({ orgId: organizationA });

    const members = await call('get', `${orgPath}/members`, manager.cookie).expect(200);
    expect(members.body.map(({ userId }: { userId: string }) => userId)).not.toContain(
      branchBMember.id,
    );

    await call('post', `${orgPath}/invitations`, manager.cookie)
      .send({ email: 'branch-b-invite@clinik.test', ...doctorB })
      .expect(403);
    const invite = await directInvitation({
      email: 'revoke-branch-b@clinik.test',
      role: 'doctor',
      branchId: otherBranch,
      invitedBy: owner.id,
    });
    await call('delete', `${orgPath}/invitations/${invite.id}`, manager.cookie).expect(403);
    await call('patch', `${orgPath}/branches/${otherBranch}`, manager.cookie)
      .send({ name: 'Out of scope' })
      .expect(403);
    await call('put', `${orgPath}/members/${target.id}/roles`, manager.cookie)
      .send({ roles: [doctorB] })
      .expect(403);
    await call('delete', `${orgPath}/members/${branchBMember.id}`, manager.cookie).expect(403);
  }, 30_000);

  it('shows clinic-wide and managed-branch roles to a branch manager', async () => {
    const manager = await member({ orgId: organizationA, roles: [managerRole] });
    const owner = await member({ orgId: organizationA, roles: [ownerRole, doctorB] });
    const admin = await member({ orgId: organizationA, roles: [adminRole, doctorB] });
    const target = await member({
      orgId: organizationA,
      roles: [doctorA, doctorB],
    });
    const members = await call('get', `${orgPath}/members`, manager.cookie).expect(200);
    const visibleRoles = (id: string) =>
      members.body.find(({ userId }: { userId: string }) => userId === id)?.roles;
    expect(visibleRoles(owner.id)).toEqual([ownerRole]);
    expect(visibleRoles(admin.id)).toEqual([adminRole]);
    expect(visibleRoles(target.id)).toEqual([doctorA]);
  }, 30_000);

  it('projects removal eligibility from all assignments and matches DELETE', async () => {
    const manager = await member({ orgId: organizationA, roles: [managerRole] });
    const local = await member({ orgId: organizationA, roles: [doctorA] });
    const mixed = await member({ orgId: organizationA, roles: [doctorA, doctorB] });
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const admin = await member({ orgId: organizationA, roles: [adminRole] });
    const list = await call('get', `${orgPath}/members`, manager.cookie).expect(200);
    const visible = (id: string) =>
      list.body.find(({ userId }: { userId: string }) => userId === id);
    expect(visible(local.id)).toMatchObject({ roles: [doctorA], canRemove: true });
    expect(visible(mixed.id)).toMatchObject({ roles: [doctorA], canRemove: false });
    expect(visible(manager.id)).toMatchObject({ canRemove: false });
    expect(visible(owner.id)).toMatchObject({ canRemove: false });

    const orgList = await call('get', `${orgPath}/members`, admin.cookie).expect(200);
    expect(
      orgList.body.find(({ userId }: { userId: string }) => userId === owner.id),
    ).toMatchObject({ canRemove: false });
    expect(
      orgList.body.find(({ userId }: { userId: string }) => userId === mixed.id),
    ).toMatchObject({ canRemove: true });
    await call('delete', `${orgPath}/members/${mixed.id}`, manager.cookie).expect(403);
    expect(await auditRowsForOrg()).toEqual([]);
    await call('delete', `${orgPath}/members/${local.id}`, manager.cookie).expect(204);
    expect(await auditRowsForOrg()).toMatchObject([{ action: 'member.removed' }]);
  }, 30_000);

  it('EXPECTED DESIGN: replacing roles must reject a role on an inactive branch', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const target = await member({ orgId: organizationA });
    await call('patch', `${orgPath}/branches/${otherBranch}`, owner.cookie)
      .send({ status: 'inactive' })
      .expect(200);
    const response = await call('put', `${orgPath}/members/${target.id}/roles`, owner.cookie).send({
      roles: [doctorB],
    });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('BRANCH_INACTIVE');
  }, 30_000);

  it('retains an inactive-branch assignment while adding a role on an active branch', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const receptionist = { role: 'receptionist', branchId: branchA };
    const target = await member({ orgId: organizationA, roles: [doctorB, receptionist] });
    const newBranch = await call('post', `${orgPath}/branches`, owner.cookie)
      .send({ name: 'Another active branch', code: 'ANOTHER', timezone: 'UTC' })
      .expect(201);
    await call('patch', `${orgPath}/branches/${otherBranch}`, owner.cookie)
      .send({ status: 'inactive' })
      .expect(200);
    const roles = [doctorB, receptionist, { role: 'doctor', branchId: newBranch.body.id }];
    await call('put', `${orgPath}/members/${target.id}/roles`, owner.cookie)
      .send({ roles })
      .expect(204);
    const response = await call('get', `${orgPath}/members`, owner.cookie).expect(200);
    const entry = response.body.find(({ userId }: { userId: string }) => userId === target.id);
    expect(entry.roles).toHaveLength(3);
    expect(entry.roles).toEqual(expect.arrayContaining(roles));
  }, 30_000);

  it('rechecks branch activity if a deactivation is already in progress', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const target = await member({ orgId: organizationA });
    const gate = await harness.adminPool.connect();
    try {
      await gate.query('BEGIN');
      await gate.query("UPDATE branches SET status = 'inactive' WHERE id = $1", [otherBranch]);
      const {
        rows: [gateInfo],
      } = await gate.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const replace = Promise.resolve(
        call('put', `${orgPath}/members/${target.id}/roles`, owner.cookie).send({
          roles: [doctorB],
        }),
      );
      void replace.catch(() => undefined);
      try {
        await waitForBlockedBy(gateInfo.pid);
        await gate.query('COMMIT');
        const result = await replace;
        expect(result.status).toBe(422);
        expect(result.body.code).toBe('BRANCH_INACTIVE');
      } finally {
        await gate.query('ROLLBACK');
        await replace.catch(() => undefined);
      }
    } finally {
      gate.release();
    }
    expect(await auditRowsForOrg()).toEqual([]);
  }, 30_000);
});

describe('grant and escalation negatives', () => {
  it('requires DELETE to remove another member’s final role', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const target = await member({ orgId: organizationA, roles: [doctorA] });
    const result = await call('put', `${orgPath}/members/${target.id}/roles`, owner.cookie)
      .send({ roles: [] })
      .expect(422);
    expect(result.body.code).toBe('EMPTY_ROLES');
    const members = await call('get', `${orgPath}/members`, owner.cookie).expect(200);
    expect(
      members.body.find(({ userId }: { userId: string }) => userId === target.id),
    ).toMatchObject({ roles: [doctorA], canRemove: true });
    expect(await auditRowsForOrg()).toEqual([]);
    await call('delete', `${orgPath}/members/${target.id}`, owner.cookie).expect(204);
  });

  it('requires a higher rank before replacing a member’s roles', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const admin = await member({ orgId: organizationA, roles: [adminRole] });
    const otherAdmin = await member({ orgId: organizationA, roles: [doctorB, adminRole] });
    const manager = await member({ orgId: organizationA, roles: [managerRole] });
    const otherManager = await member({ orgId: organizationA, roles: [managerRole] });
    const doctor = await member({ orgId: organizationA, roles: [doctorA] });
    const mixed = await member({ orgId: organizationA, roles: [doctorA, doctorB] });
    const receptionist = { role: 'receptionist', branchId: branchA };
    const replace = (
      cookie: string,
      id: string,
      roles: { role: string; branchId: string | null }[],
    ) => call('put', `${orgPath}/members/${id}/roles`, cookie).send({ roles });

    const denied = [
      [admin.cookie, owner.id, [ownerRole, doctorA]],
      [admin.cookie, otherAdmin.id, [adminRole, doctorB, doctorA]],
      [manager.cookie, otherAdmin.id, [adminRole, doctorB, doctorA]],
      [manager.cookie, otherManager.id, [managerRole, doctorA]],
      [manager.cookie, mixed.id, [doctorA, doctorB, receptionist]],
      [doctor.cookie, manager.id, [managerRole, doctorA]],
    ] as const;
    for (const [cookie, id, roles] of denied)
      expect((await replace(cookie, id, [...roles]).expect(403)).body.code).toBe('FORBIDDEN');
    expect(await auditRowsForOrg()).toEqual([]);

    const branchMembers = await call('get', `${orgPath}/members`, manager.cookie).expect(200);
    const branchRow = (id: string) =>
      branchMembers.body.find(({ userId }: { userId: string }) => userId === id);
    expect(branchRow(doctor.id)).toMatchObject({ roles: [doctorA], canEditRoles: true });
    expect(branchRow(mixed.id)).toMatchObject({ roles: [doctorA], canEditRoles: false });

    await replace(owner.cookie, otherAdmin.id, [adminRole, doctorA]).expect(204);
    await replace(manager.cookie, doctor.id, [doctorA, receptionist]).expect(204);
    const members = await call('get', `${orgPath}/members`, owner.cookie).expect(200);
    const savedRoles = (id: string) =>
      members.body.find(({ userId }: { userId: string }) => userId === id)?.roles;
    expect(savedRoles(owner.id)).toEqual([ownerRole]);
    expect(savedRoles(otherAdmin.id)).toEqual([doctorA, adminRole]);
    expect(savedRoles(doctor.id)).toEqual([doctorA, receptionist]);
  }, 30_000);

  it('permits only strict self-removal of non-owner roles while preserving a role', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole, managerRole] });
    const admin = await member({ orgId: organizationA, roles: [adminRole] });
    const manager = await member({ orgId: organizationA, roles: [managerRole, doctorB] });
    const replaceSelf = (
      user: { id: string; cookie: string },
      roles: readonly { role: string; branchId: string | null }[],
    ) => call('put', `${orgPath}/members/${user.id}/roles`, user.cookie).send({ roles });
    for (const roles of [
      [ownerRole, managerRole, doctorA],
      [ownerRole, managerRole],
      [ownerRole, doctorB],
    ])
      expect((await replaceSelf(owner, roles).expect(403)).body.code).toBe('SELF_GRANT_FORBIDDEN');
    expect((await replaceSelf(owner, [managerRole]).expect(403)).body.code).toBe('FORBIDDEN');
    expect((await replaceSelf(admin, []).expect(422)).body.code).toBe('LAST_ROLE');
    expect(await auditRowsForOrg()).toEqual([]);

    const branchMembers = await call('get', `${orgPath}/members`, manager.cookie).expect(200);
    expect(
      branchMembers.body.find(({ userId }: { userId: string }) => userId === manager.id),
    ).toMatchObject({ roles: [managerRole], canEditRoles: true });
    await replaceSelf(manager, [managerRole]).expect(204);
    await replaceSelf(owner, [ownerRole]).expect(204);
    expect((await replaceSelf(owner, []).expect(403)).body.code).toBe('FORBIDDEN');
    const members = await call('get', `${orgPath}/members`, owner.cookie).expect(200);
    expect(
      members.body.find(({ userId }: { userId: string }) => userId === owner.id),
    ).toMatchObject({ roles: [ownerRole], canEditRoles: false });
    expect(await auditRowsForOrg()).toMatchObject([
      { action: 'member.roles_replaced', metadata: { self: true }, changed_fields: ['roles'] },
      { action: 'member.roles_replaced', metadata: { self: true }, changed_fields: ['roles'] },
    ]);
  }, 30_000);

  it('checks a target’s promoted rank after an admin’s PUT waits for the organization lock', async () => {
    const admin = await member({ orgId: organizationA, roles: [adminRole] });
    const target = await member({ orgId: organizationA, roles: [doctorA] });
    const gate = await harness.adminPool.connect();
    try {
      await gate.query('BEGIN');
      await gate.query('SELECT id FROM organizations WHERE id = $1 FOR NO KEY UPDATE', [
        organizationA,
      ]);
      const {
        rows: [{ pid }],
      } = await gate.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const replace = Promise.resolve(
        call('put', `${orgPath}/members/${target.id}/roles`, admin.cookie).send({
          roles: [doctorA, adminRole, { role: 'receptionist', branchId: branchA }],
        }),
      );
      void replace.catch(() => undefined);
      try {
        await waitForBlockedBy(pid);
        await gate.query(
          "INSERT INTO staff_role_assignments (organization_id, user_id, role) VALUES ($1, $2, 'org_admin')",
          [organizationA, target.id],
        );
        await gate.query('COMMIT');
        const result = await replace;
        expect(result.status).toBe(403);
        expect(result.body.code).toBe('FORBIDDEN');
      } finally {
        await gate.query('ROLLBACK');
        await replace.catch(() => undefined);
      }
    } finally {
      gate.release();
    }
    const members = await call('get', `${orgPath}/members`, admin.cookie).expect(200);
    expect(
      members.body.find(({ userId }: { userId: string }) => userId === target.id),
    ).toMatchObject({ roles: [doctorA, adminRole], canEditRoles: false });
    expect(await auditRowsForOrg()).toEqual([]);
  }, 30_000);

  it('no tenant route can grant org_owner or org_admin outside the platform owner-invite endpoint', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const admin = await member({ orgId: organizationA, roles: [adminRole] });
    const target = await member({ orgId: organizationA });
    await call('post', `${orgPath}/invitations`, owner.cookie)
      .send({ email: 'owner-through-invite@clinik.test', role: 'org_owner', branchId: null })
      .expect(403);
    await call('put', `${orgPath}/members/${target.id}/roles`, owner.cookie)
      .send({ roles: [{ role: 'org_owner', branchId: null }] })
      .expect(403);
    await call('post', `${orgPath}/invitations`, admin.cookie)
      .send({ email: 'admin-through-invite@clinik.test', role: 'org_admin', branchId: null })
      .expect(403);
    await call('put', `${orgPath}/members/${target.id}/roles`, admin.cookie)
      .send({ roles: [adminRole] })
      .expect(403);
  }, 30_000);
});

describe('P5(b) ownership transfer with a wrong current password', () => {
  it('audits failures per session and revokes only the fifth-failure session', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const target = await member({ orgId: organizationA, roles: [adminRole] });
    const sessions = app.get(SessionService);
    const original = await sessions.validate(owner.cookie.split('=')[1]);
    if (original.status !== 'valid') throw new Error('Expected a valid test session');
    const other = await sessions.create(owner.id, { ip: null, userAgent: null });
    const otherCookie = `__Host-session=${other.rawToken}`;
    const transfer = (cookie: string, currentPassword = 'wrong-review-password') =>
      call('post', `${orgPath}/ownership-transfer`, cookie).send({
        newOwnerUserId: target.id,
        currentPassword,
      });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await transfer(owner.cookie).expect(422);
      expect(response.body.code).toBe('INVALID_PASSWORD');
    }
    await transfer(otherCookie).expect(422);
    const denied = await transfer(owner.cookie).expect(401);
    expect(denied.body.code).toBe('UNAUTHENTICATED');
    await transfer(owner.cookie, password).expect(401);
    await call('get', '/api/v1/auth/me', otherCookie).expect(200);
    const { rows } = await harness.adminPool.query(
      'SELECT failed_login_count, locked_until FROM users WHERE id = $1',
      [owner.id],
    );
    expect(rows).toEqual([{ failed_login_count: 0, locked_until: null }]);
    const audits = await harness.adminPool.query(
      'SELECT action, outcome, organization_id, actor_user_id, resource_id, metadata FROM audit_logs ORDER BY id',
    );
    expect(audits.rows).toEqual([
      ...Array.from({ length: 6 }, () => ({
        action: 'org.ownership_transfer.denied',
        outcome: 'denied',
        organization_id: organizationA,
        actor_user_id: owner.id,
        resource_id: organizationA,
        metadata: {},
      })),
      {
        action: 'auth.session.revoked',
        outcome: 'success',
        organization_id: null,
        actor_user_id: owner.id,
        resource_id: original.context.sessionId,
        metadata: { reason: 'reauth_failed' },
      },
    ]);
  }, 60_000);

  it('persists denials independently and preserves the count when audit or revocation fails', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const target = await member({ orgId: organizationA, roles: [adminRole] });
    const transfer = () =>
      call('post', `${orgPath}/ownership-transfer`, owner.cookie).send({
        newOwnerUserId: target.id,
        currentPassword: 'incorrect',
      });
    const record = AuditWriter.prototype.record;
    const audit = vi.spyOn(AuditWriter.prototype, 'record');
    const sessions = app.get(SessionService);
    const revoke = vi.spyOn(sessions, 'revoke');
    const log = vi.spyOn(logger, 'error');
    try {
      audit.mockRejectedValueOnce(new TypeError('Synthetic audit write failure'));
      const auditFailed = await transfer().expect(503);
      expect(auditFailed.body.code).toBe('SERVICE_UNAVAILABLE');
      expect(await auditRowsForOrg()).toEqual([]);
      for (let attempt = 0; attempt < 4; attempt += 1) await transfer().expect(422);
      expect(revoke).not.toHaveBeenCalled();
      audit.mockImplementation(async function (this: AuditWriter, ...args) {
        if (args[0].action === 'auth.session.revoked') {
          audit.mockImplementation(record);
          throw new TypeError('Synthetic session write failure');
        }
        return record.apply(this, args);
      });
      const revokeFailed = await transfer().expect(503);
      expect(revokeFailed.body.code).toBe('SERVICE_UNAVAILABLE');
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: revokeFailed.body.requestId,
          errorClass: 'TypeError',
        }),
        'HTTP request failed',
      );
      const failures = log.mock.calls.filter(([, message]) => message === 'HTTP request failed');
      expect(JSON.stringify(failures)).not.toContain('Synthetic session write failure');
      await call('get', orgPath, owner.cookie).expect(200);
      expect(await auditRowsForOrg()).toHaveLength(5);
      await transfer().expect(401);
      await call('get', orgPath, owner.cookie).expect(401);
      expect(await auditRowsForOrg()).toHaveLength(6);
      const denials = audit.mock.calls.filter(
        ([event]) => event.action === 'org.ownership_transfer.denied',
      );
      expect(denials).toHaveLength(7);
      expect(denials.every((args) => args.length === 1)).toBe(true);
      expect(revoke).toHaveBeenCalledTimes(2);
      expect(revoke.mock.calls.every((args) => args.length === 2)).toBe(true);
    } finally {
      audit.mockRestore();
      revoke.mockRestore();
      log.mockRestore();
    }
  }, 30_000);

  it.each([false, true])(
    'rejects overlapping re-auth only for the same session (different session: %s)',
    async (differentSession) => {
      const owner = await member({ orgId: organizationA, roles: [ownerRole] });
      const target = await member({ orgId: organizationA, roles: [adminRole] });
      const other = await app.get(SessionService).create(owner.id, { ip: null, userAgent: null });
      const entered = deferredSignal();
      const release = deferredSignal();
      const verify = vi
        .spyOn(app.get(PasswordService), 'verify')
        .mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return false;
        });
      const transfer = (cookie: string) =>
        call('post', `${orgPath}/ownership-transfer`, cookie)
          .send({ newOwnerUserId: target.id, currentPassword: 'wrong-concurrent-password' })
          .timeout({ response: 8_000 });
      const first = transfer(owner.cookie).then((response) => response);
      try {
        await Promise.race([
          entered.promise,
          first.then(({ status }) => {
            throw new Error(`Transfer finished during setup: ${status}`);
          }),
        ]);
        await call('get', '/api/v1/health').expect(200);
        const second = await transfer(
          differentSession ? `__Host-session=${other.rawToken}` : owner.cookie,
        );
        expect(second.status).toBe(differentSession ? 422 : 429);
        expect(second.headers['content-type']).toContain('application/problem+json');
        expect(second.body.code).toBe(differentSession ? 'INVALID_PASSWORD' : 'REAUTH_IN_PROGRESS');
        expect(verify).toHaveBeenCalledTimes(differentSession ? 2 : 1);
        expect(await auditRowsForOrg()).toHaveLength(differentSession ? 1 : 0);
      } finally {
        release.resolve();
        verify.mockRestore();
        await first;
      }
      expect((await first).status).toBe(422);
      expect((await auditRowsForOrg()).map(({ action }) => action)).toEqual(
        Array(differentSession ? 2 : 1).fill('org.ownership_transfer.denied'),
      );
      await call('get', '/api/v1/health').expect(200);
      expect(await idleInTransaction()).toBe(0);
    },
    30_000,
  );

  it('commits the fifth denial and session revocation before answering 401', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const target = await member({ orgId: organizationA, roles: [adminRole] });
    const transfer = () =>
      call('post', `${orgPath}/ownership-transfer`, owner.cookie)
        .send({ newOwnerUserId: target.id, currentPassword: 'incorrect' })
        .timeout({ response: 8_000 });
    for (let attempt = 0; attempt < 4; attempt += 1) await transfer().expect(422);
    const revokeStarted = deferredSignal();
    const release = deferredSignal();
    const sessions = app.get(SessionService);
    const revokeSession = sessions.revoke.bind(sessions);
    const revoke = vi.spyOn(sessions, 'revoke').mockImplementationOnce(async (...args) => {
      revokeStarted.resolve();
      await release.promise;
      return revokeSession(...args);
    });
    let answered = false;
    const fifth = transfer().then((response) => {
      answered = true;
      return response;
    });
    try {
      await Promise.race([
        revokeStarted.promise,
        fifth.then(({ status }) => {
          throw new Error(`Transfer finished before revocation: ${status}`);
        }),
      ]);
      expect(await auditRowsForOrg()).toHaveLength(5);
      expect(await idleInTransaction()).toBe(0);
      await transfer().expect(429);
      await call('get', '/api/v1/auth/me', owner.cookie).expect(200);
      expect(answered).toBe(false);
    } finally {
      release.resolve();
      revoke.mockRestore();
      await fifth;
    }
    expect((await fifth).status).toBe(401);
    expect((await fifth).body.code).toBe('UNAUTHENTICATED');
    await call('get', '/api/v1/auth/me', owner.cookie).expect(401);
    const { rows } = await harness.adminPool.query(
      "SELECT metadata FROM audit_logs WHERE action = 'auth.session.revoked'",
    );
    expect(rows).toEqual([{ metadata: { reason: 'reauth_failed' } }]);
  }, 30_000);

  it('resets the failure count after a committed transfer', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const target = await member({ orgId: organizationA, roles: [adminRole] });
    const transfer = (cookie: string, newOwnerUserId: string, currentPassword: string) =>
      call('post', `${orgPath}/ownership-transfer`, cookie).send({
        newOwnerUserId,
        currentPassword,
      });
    for (let attempt = 0; attempt < 4; attempt += 1)
      await transfer(owner.cookie, target.id, 'incorrect').expect(422);
    await transfer(owner.cookie, target.id, password).expect(204);
    await transfer(target.cookie, owner.id, password).expect(204);
    for (let attempt = 0; attempt < 4; attempt += 1)
      await transfer(owner.cookie, target.id, 'incorrect').expect(422);
    await transfer(owner.cookie, target.id, 'incorrect').expect(401);
  }, 30_000);

  it('verifies the current password without holding organization, user, or session row locks', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const target = await member({ orgId: organizationA, roles: [adminRole] });
    const service = app.get(PasswordService);
    const verifyPassword = service.verify.bind(service);
    let resume!: () => void;
    const pause = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const verify = vi.spyOn(service, 'verify').mockImplementationOnce(async (hash, plain) => {
      await pause;
      return verifyPassword(hash, plain);
    });
    const first = Promise.resolve(
      call('post', `${orgPath}/ownership-transfer`, owner.cookie).send({
        newOwnerUserId: target.id,
        currentPassword: password,
      }),
    );
    void first.catch(() => undefined);
    const gate = await superuser.connect();
    try {
      await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce());
      await gate.query('BEGIN');
      await gate.query('SELECT id FROM organizations WHERE id = $1 FOR NO KEY UPDATE NOWAIT', [
        organizationA,
      ]);
      await gate.query('SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE NOWAIT', [owner.id]);
      await gate.query('SELECT id FROM sessions WHERE user_id = $1 FOR NO KEY UPDATE NOWAIT', [
        owner.id,
      ]);
    } finally {
      await gate.query('ROLLBACK');
      gate.release();
      resume();
      verify.mockRestore();
      await first.catch(() => undefined);
    }
    expect((await first).status).toBe(204);
  }, 30_000);
});

describe('M1 post-audit tenancy checks', () => {
  it('returns a 503 problem within one second of the pool acquire timeout', async () => {
    const { pool } = app.get<DatabaseConnection>(DATABASE);
    const clients: PoolClient[] = [];
    try {
      for (let index = 0; index < 10; index += 1) clients.push(await pool.connect());
      const timeout = pool.options.connectionTimeoutMillis ?? 5_000;
      const response = await call('get', '/api/v1/health')
        .timeout({ response: timeout + 1_000 })
        .expect(503);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.body.code).toBe('SERVICE_UNAVAILABLE');
    } finally {
      for (const client of clients) client.release();
    }
    await call('get', '/api/v1/health').expect(200);
    expect(await idleInTransaction()).toBe(0);
  }, 30_000);

  it.each<[string, string | null]>([
    ['Asia/Kolkata', 'Asia/Kolkata'],
    ['Asia/Calcutta', 'Asia/Kolkata'],
    ['Mars/Phobos', null],
    ['+05:30', null],
    ['-03:00', null],
    ['Etc/GMT+5', null],
    ['EST', null],
    ['EST5EDT', null],
    ['GMT', null],
    ['asia/kolkata', 'Asia/Kolkata'],
    ['Etc/UTC', 'UTC'],
    ['America/Argentina/Buenos_Aires', 'America/Argentina/Buenos_Aires'],
  ])('validates and canonicalizes %s for organizations and branches', async (zone, stored) => {
    const platform = await member({ platform: true });
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const status = stored === null ? 422 : 201;
    const createdOrg = await call('post', '/api/v1/admin/organizations', platform.cookie)
      .send({ name: 'Timezone Clinic', slug: 'timezone-clinic', defaultTimezone: zone })
      .expect(status);
    const createdBranch = await call('post', `${orgPath}/branches`, owner.cookie)
      .send({ name: 'Timezone Branch', code: 'TZ', timezone: zone })
      .expect(status);
    if (status === 422) {
      expect(createdOrg.body.code).toBe('INVALID_TIMEZONE');
      expect(createdBranch.body.code).toBe('INVALID_TIMEZONE');
      return;
    }
    const org = await harness.adminPool.query(
      'SELECT default_timezone FROM organizations WHERE id = $1',
      [createdOrg.body.id],
    );
    const branch = await harness.adminPool.query('SELECT timezone FROM branches WHERE id = $1', [
      createdBranch.body.id,
    ]);
    expect(org.rows).toEqual([{ default_timezone: stored }]);
    expect(branch.rows).toEqual([{ timezone: stored }]);
  });

  it('rejects the invitation after the inviter loses grant authority', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const admin = await member({ orgId: organizationA, roles: [adminRole] });
    const invitation = await directInvitation({
      email: 'demoted-inviter-test@clinik.test',
      ...managerRole,
      invitedBy: admin.id,
    });
    await call('put', `${orgPath}/members/${admin.id}/roles`, owner.cookie)
      .send({ roles: [doctorA] })
      .expect(204);
    const result = await call('post', `${invitation.path}/accept`)
      .send({ fullName, password })
      .expect(404);
    expect(result.body.code).toBe('NOT_FOUND');
  });

  it('revokes and audits pending invitations when the inviter is removed', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const admin = await member({ orgId: organizationA, roles: [adminRole] });
    const invitation = await directInvitation({
      email: 'removed-inviter-test@clinik.test',
      ...managerRole,
      invitedBy: admin.id,
    });
    await call('delete', `${orgPath}/members/${admin.id}`, owner.cookie).expect(204);
    const { rows } = await harness.adminPool.query(
      'SELECT revoked_at FROM invitations WHERE id = $1',
      [invitation.id],
    );
    expect(rows).toEqual([{ revoked_at: expect.any(Date) }]);
    const audit = await harness.adminPool.query(
      'SELECT actor_user_id, metadata FROM audit_logs WHERE action = $1 AND resource_id = $2',
      ['invitation.revoked', invitation.id],
    );
    expect(audit.rows).toEqual([
      { actor_user_id: owner.id, metadata: { reason: 'inviter_removed' } },
    ]);
    const result = await call('post', `${invitation.path}/accept`)
      .send({ fullName, password })
      .expect(404);
    expect(result.body.code).toBe('NOT_FOUND');
  });

  it('accepts an owner invitation issued by a platform admin with no membership', async () => {
    const platform = await member({ platform: true });
    const invitation = await directInvitation({
      email: 'platform-invitee@clinik.test',
      ...ownerRole,
      invitedBy: platform.id,
    });
    await call('post', `${invitation.path}/accept`).send({ fullName, password }).expect(204);
    const { rows } = await harness.adminPool.query(
      'SELECT role FROM staff_role_assignments WHERE organization_id = $1 AND created_by = $2',
      [organizationA, platform.id],
    );
    expect(rows).toEqual([{ role: 'org_owner' }]);
  });
});

describe('invitation and transfer races', () => {
  it('returns the generic 404 for an invitation accepted against a suspended org', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const invitation = await directInvitation({
      email: 'suspended-org@clinik.test',
      role: 'doctor',
      branchId: branchA,
      invitedBy: owner.id,
    });
    await harness.adminPool.query('UPDATE organizations SET status = $1 WHERE id = $2', [
      'suspended',
      organizationA,
    ]);
    const preview = await call('get', invitation.path).expect(404);
    expect(preview.body.code).toBe('NOT_FOUND');
    const accepted = await call('post', `${invitation.path}/accept`)
      .send({ fullName, password })
      .expect(404);
    expect(accepted.body.code).toBe('NOT_FOUND');
    await call('get', orgPath, owner.cookie).expect(404);
    const me = await call('get', '/api/v1/auth/me', owner.cookie).expect(200);
    expect(me.body.memberships).toEqual([]);
  }, 30_000);

  it("EXPECTED DESIGN: accepting a new-user invite must not revoke a different user's session", async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const bystander = await member({ orgId: organizationA, roles: [doctorA] });
    const invitation = await directInvitation({
      email: 'brand-new-account@clinik.test',
      role: 'doctor',
      branchId: branchA,
      invitedBy: owner.id,
    });
    await harness.adminPool.query(
      "UPDATE sessions SET last_seen_at = now() - interval '2 minutes' WHERE user_id = $1",
      [bystander.id],
    );
    const bystanderSession = () =>
      harness.adminPool.query(
        'SELECT last_seen_at, idle_expires_at, revoked_at FROM sessions WHERE user_id = $1',
        [bystander.id],
      );
    const before = await bystanderSession();
    await call('post', `${invitation.path}/accept`, bystander.cookie)
      .send({ fullName, password })
      .expect(204);
    expect((await bystanderSession()).rows).toEqual(before.rows);
    await call('get', '/api/v1/auth/me', bystander.cookie).expect(200);
  }, 30_000);

  it('serializes an ownership transfer against removal of the target', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const target = await member({ orgId: organizationA, roles: [adminRole] });
    const [transfer, removal] = await Promise.all([
      call('post', `${orgPath}/ownership-transfer`, owner.cookie).send({
        newOwnerUserId: target.id,
        currentPassword: password,
      }),
      call('delete', `${orgPath}/members/${target.id}`, owner.cookie),
    ]);
    expect([transfer.status, removal.status]).toContain(204);
    expect(transfer.status === 204 ? removal.status : transfer.status).toBe(
      transfer.status === 204 ? 403 : 404,
    );
    const owners = await harness.adminPool.query(
      `SELECT user_id FROM staff_role_assignments
       WHERE organization_id = $1 AND role = 'org_owner'`,
      [organizationA],
    );
    expect(owners.rows).toHaveLength(1);
    expect(owners.rows[0].user_id).toBe(transfer.status === 204 ? target.id : owner.id);
  }, 30_000);
});

describe('member removal and audit', () => {
  it('computes removal rank from the highest multi-role rank and forbids peers', async () => {
    const oa = await member({ orgId: organizationA, roles: [adminRole, doctorA] });
    const manager = await member({ orgId: organizationA, roles: [managerRole, doctorA] });
    const peer = await member({ orgId: organizationA, roles: [managerRole] });
    await call('delete', `${orgPath}/members/${oa.id}`, manager.cookie).expect(403);
    await call('delete', `${orgPath}/members/${peer.id}`, manager.cookie).expect(403);
    await call('delete', `${orgPath}/members/${manager.id}`, oa.cookie).expect(204);
  }, 30_000);

  it('writes exactly one audit row per mutation, with field names and never values', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const target = await member({ orgId: organizationA, roles: [doctorA] });
    const code = `AUDIT${randomBytes(3).toString('hex').toUpperCase()}`;
    await call('post', `${orgPath}/branches`, owner.cookie)
      .send({ name: 'Audit branch', code, timezone: 'UTC' })
      .expect(201);
    await call('patch', orgPath, owner.cookie).send({ name: 'Renamed Clinic' }).expect(200);
    const email = 'audit-invite@clinik.test';
    const created = await call('post', `${orgPath}/invitations`, owner.cookie)
      .send({ email, ...doctorA })
      .expect(201);
    await call('delete', `${orgPath}/invitations/${created.body.id}`, owner.cookie).expect(204);
    await call('put', `${orgPath}/members/${target.id}/roles`, owner.cookie)
      .send({ roles: [{ role: 'receptionist', branchId: branchA }] })
      .expect(204);
    await call('delete', `${orgPath}/members/${target.id}`, owner.cookie).expect(204);

    const rows = await auditRowsForOrg();
    expect(rows.map(({ action }) => action)).toEqual([
      'branch.created',
      'organization.updated',
      'invitation.created',
      'invitation.revoked',
      'member.roles_replaced',
      'member.removed',
    ]);
    for (const row of rows) {
      expect(row.organization_id).toBe(organizationA);
      expect(row.metadata).toEqual({});
      const changed = (row.changed_fields ?? []) as string[];
      expect(changed.every((field) => /^[a-z][A-Za-z0-9]*$/.test(field))).toBe(true);
      expect(changed).not.toContain(email);
      expect(changed).not.toContain('Renamed Clinic');
      expect(JSON.stringify(row)).not.toContain(email);
    }
  }, 30_000);
});

describe('P5(a) invitation listing behaviour', () => {
  it('lists invitations by status and branch scope without exposing another organization', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const manager = await member({ orgId: organizationA, roles: [managerRole] });
    const foreign = await member({ orgId: organizationB, roles: [ownerRole] });
    const create = (email: string, branchId: string | null, orgId = organizationA) =>
      directInvitation({
        orgId,
        email,
        branchId,
        role: branchId ? 'doctor' : 'org_admin',
        invitedBy: orgId === organizationA ? owner.id : foreign.id,
      });
    const [pending, other, orgWide, foreignInvite, accepted, revoked, expired] = await Promise.all([
      create('pending@clinik.test', branchA),
      create('other-branch@clinik.test', otherBranch),
      create('org-wide@clinik.test', null),
      create('foreign@clinik.test', foreignBranch, organizationB),
      create('accepted@clinik.test', branchA),
      create('revoked@clinik.test', branchA),
      create('expired@clinik.test', branchA),
    ]);
    await harness.adminPool.query('UPDATE invitations SET accepted_at = now() WHERE id = $1', [
      accepted.id,
    ]);
    await harness.adminPool.query('UPDATE invitations SET revoked_at = now() WHERE id = $1', [
      revoked.id,
    ]);
    await harness.adminPool.query(
      "UPDATE invitations SET expires_at = now() - interval '1 second' WHERE id = $1",
      [expired.id],
    );
    const list = (cookie: string, query = '') =>
      call('get', `${orgPath}/invitations${query}`, cookie);
    const scoped = await list(manager.cookie, '?status=pending').expect(200);
    expect(scoped.body.nextCursor).toBeNull();
    expect(scoped.body.items).toEqual([
      {
        id: pending.id,
        role: 'doctor',
        email: 'pending@clinik.test',
        branchId: branchA,
        expiresAt: expect.any(String),
        createdAt: expect.any(String),
        status: 'pending',
      },
    ]);
    expect((await list(manager.cookie).expect(200)).body).toEqual(scoped.body);
    const all = await list(manager.cookie, '?status=all').expect(200);
    expect(
      all.body.items.map(({ id, status }: { id: string; status: string }) => [id, status]).sort(),
    ).toEqual(
      [
        [pending.id, 'pending'],
        [accepted.id, 'accepted'],
        [revoked.id, 'revoked'],
        [expired.id, 'expired'],
      ].sort(),
    );
    const organizationList = await list(owner.cookie, '?status=all').expect(200);
    expect(organizationList.body.items.map(({ id }: { id: string }) => id).sort()).toEqual(
      [pending.id, other.id, orgWide.id, accepted.id, revoked.id, expired.id].sort(),
    );
    expect(organizationList.body.items.map(({ id }: { id: string }) => id)).not.toContain(
      foreignInvite.id,
    );
    await call(
      'get',
      `/api/v1/orgs/${organizationB}/invitations?status=all`,
      manager.cookie,
    ).expect(404);
    await list(foreign.cookie).expect(404);
    await list(manager.cookie, '?status=invalid').expect(400);
  }, 30_000);

  it('declares only the public list fields in OpenAPI and keeps the create response free of token data', async () => {
    const list = document.paths['/api/v1/orgs/{orgId}/invitations'].get;
    expect(list?.responses['200']).toMatchObject({
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/InvitationPageDto' },
        },
      },
    });
    const schema = document.components?.schemas?.InvitationListItemDto;
    expect(schema).toBeDefined();
    expect(schema && 'properties' in schema && Object.keys(schema.properties ?? {}).sort()).toEqual(
      ['id', 'email', 'role', 'branchId', 'expiresAt', 'createdAt', 'status'].sort(),
    );
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const created = await call('post', `${orgPath}/invitations`, owner.cookie)
      .send({ email: 'list-check@clinik.test', ...doctorA })
      .expect(201);
    expect(Object.keys(created.body).sort()).toEqual(['emailDelivery', 'expiresAt', 'id']);
    expect(JSON.stringify(created.body)).not.toMatch(/[A-Za-z0-9_-]{43}/);
  }, 30_000);
});

const orgPrefix = '/api/v1/orgs/:orgId';
const platformPrefix = '/api/v1/admin/organizations';
const testedRoles = [
  'platform_admin',
  'org_owner',
  'org_admin',
  'branch_manager',
  'doctor',
  'receptionist',
  'member_without_role',
] as const;
const variants = ['own branch', 'other branch', 'other organization'] as const;
type TestedRole = (typeof testedRoles)[number];
type Variant = (typeof variants)[number];

interface RouteFixture {
  orgId: string;
  branchId: string;
  invitationId: string;
  memberId: string;
  memberRole: StaffRole;
  ownershipId: string;
  actorId: string;
  patientId: string;
}

type ResourceKey = Exclude<keyof RouteFixture, 'orgId' | 'memberRole'>;
interface RouteCase {
  permission: Permission;
  status: number;
  branchScoped?: boolean;
  rankedTarget?: boolean;
  resourceKeys?: readonly ResourceKey[];
  body?: (fixture: RouteFixture) => Record<string, unknown>;
}

const platform = 'platform.org.manage';
const routeCases: Record<string, RouteCase> = {
  [`GET ${orgPrefix}`]: { permission: 'org.read', status: 200 },
  [`PATCH ${orgPrefix}`]: {
    permission: 'org.update',
    status: 200,
    body: () => ({ name: 'Updated' }),
  },
  [`GET ${orgPrefix}/branches`]: { permission: 'org.read', status: 200 },
  [`POST ${orgPrefix}/branches`]: {
    permission: 'branch.manage',
    status: 201,
    body: () => ({ code: 'NEW', name: 'New Branch', timezone: 'UTC' }),
  },
  [`GET ${orgPrefix}/branches/:id`]: {
    permission: 'org.read',
    status: 200,
    resourceKeys: ['branchId'],
  },
  [`PATCH ${orgPrefix}/branches/:id`]: {
    permission: 'branch.update',
    status: 200,
    branchScoped: true,
    resourceKeys: ['branchId'],
    body: () => ({ name: 'Updated Branch' }),
  },
  [`GET ${orgPrefix}/members`]: { permission: 'member.list', status: 200 },
  [`GET ${orgPrefix}/invitations`]: { permission: 'member.list', status: 200 },
  [`POST ${orgPrefix}/invitations`]: {
    permission: 'member.manage',
    status: 201,
    branchScoped: true,
    resourceKeys: ['branchId'],
    body: ({ branchId }) => ({ branchId, role: 'doctor', email: 'new-invite@clinik.test' }),
  },
  [`DELETE ${orgPrefix}/invitations/:id`]: {
    permission: 'member.manage',
    status: 204,
    branchScoped: true,
    resourceKeys: ['invitationId'],
  },
  [`PUT ${orgPrefix}/members/:userId/roles`]: {
    permission: 'member.manage',
    status: 204,
    branchScoped: true,
    rankedTarget: true,
    resourceKeys: ['memberId', 'branchId'],
    body: ({ memberRole, branchId }) => ({
      roles: [fixtureAssignment(memberRole, branchId), { role: 'receptionist', branchId }],
    }),
  },
  [`DELETE ${orgPrefix}/members/:userId`]: {
    permission: 'member.manage',
    status: 204,
    branchScoped: true,
    rankedTarget: true,
    resourceKeys: ['memberId'],
  },
  [`POST ${orgPrefix}/ownership-transfer`]: {
    permission: 'org.ownership.transfer',
    status: 204,
    resourceKeys: ['ownershipId'],
    body: ({ ownershipId }) => ({ newOwnerUserId: ownershipId, currentPassword: password }),
  },
  [`GET ${orgPrefix}/audit-logs`]: {
    permission: 'audit.read',
    status: 200,
    resourceKeys: ['actorId', 'patientId'],
  },
  [`GET ${platformPrefix}`]: { permission: platform, status: 200 },
  [`POST ${platformPrefix}`]: {
    permission: platform,
    status: 201,
    body: () => ({ slug: 'from-platform', name: 'From Platform', defaultTimezone: 'UTC' }),
  },
  [`GET ${platformPrefix}/:id`]: { permission: platform, status: 200 },
  [`PATCH ${platformPrefix}/:id`]: {
    permission: platform,
    status: 200,
    body: () => ({ name: 'Updated' }),
  },
  [`POST ${platformPrefix}/:id/suspend`]: { permission: platform, status: 200 },
  [`POST ${platformPrefix}/:id/reactivate`]: { permission: platform, status: 200 },
  [`POST ${platformPrefix}/:id/owner-invitation`]: {
    permission: platform,
    status: 201,
    body: () => ({ email: 'first-owner@clinik.test' }),
  },
};

function enumerateAccessRoutes() {
  const { router } = app.getHttpAdapter().getInstance() as { router: { stack: ExpressLayer[] } };
  const metadata = new Map(
    collectControllerRoutes(app).map((route) => [`${route.method} ${route.path}`, route]),
  );
  return collectMountedRoutes(router.stack)
    .filter(({ key }) => / (?:<nested>)?\/api\/v1\/(?:orgs|admin)(?:\/|$)/.test(key))
    .map(({ key }) => ({ key, metadata: metadata.get(key), scenario: routeCases[key] }));
}

function fixtureAssignment(role: StaffRole, branchId: string) {
  return { role, branchId: role === 'org_owner' || role === 'org_admin' ? null : branchId };
}

async function makeRouteFixture(
  orgId: string,
  branchId: string,
  memberRole: StaffRole = 'doctor',
): Promise<RouteFixture> {
  const target = await member({ orgId, roles: [fixtureAssignment(memberRole, branchId)] });
  const candidate = await member({ orgId, roles: [{ role: 'doctor', branchId }] });
  const invitation = await directInvitation({
    orgId,
    email: 'fixture-invitation@clinik.test',
    role: 'doctor',
    branchId,
    invitedBy: target.id,
  });
  const patientId = randomUUID();
  await harness.adminPool.query(
    `INSERT INTO audit_logs
        (organization_id, actor_user_id, actor_type, action, resource_type, patient_id, outcome)
     VALUES ($1, $2, 'user', 'demo.view', 'patient', $3, 'success')`,
    [orgId, candidate.id, patientId],
  );
  return {
    orgId,
    branchId,
    invitationId: invitation.id,
    memberId: target.id,
    memberRole,
    ownershipId: candidate.id,
    actorId: candidate.id,
    patientId,
  };
}

function exerciseRoute(key: string, cookie: string, fixture: RouteFixture) {
  const [verb, pattern] = key.split(' ') as [string, string];
  const platformRoute = pattern.startsWith(platformPrefix);
  const path = pattern
    .replace(':orgId', fixture.orgId)
    .replace(':userId', fixture.memberId)
    .replace(
      ':id',
      platformRoute
        ? fixture.orgId
        : pattern.includes('/invitations/')
          ? fixture.invitationId
          : fixture.branchId,
    );
  const test = call(verb.toLowerCase() as Method, path, cookie);
  if (pattern.endsWith('/audit-logs'))
    test.query({ actorId: fixture.actorId, patientId: fixture.patientId });
  const body = routeCases[key].body?.(fixture);
  return body ? test.send(body) : test;
}

function expectedStatus(
  role: TestedRole,
  variant: Variant,
  route: RouteCase,
  memberRole: StaffRole,
) {
  const scopes = matrixScopesFor(route.permission);
  const scope = role === 'member_without_role' ? undefined : scopes[role];
  if (route.permission === platform) return scope === 'P' ? route.status : 404;
  if (role === 'platform_admin' || variant === 'other organization') return 404;
  if (!scope) return 403;
  if (route.branchScoped && scope !== 'O') {
    const hasBranchScope = scope === 'B' || (typeof scope !== 'string' && scope.includes('B'));
    if (!hasBranchScope || variant !== 'own branch') return 403;
  }
  if (route.rankedTarget && matrixStaffRanks[role as StaffRole] <= matrixStaffRanks[memberRole])
    return 403;
  return route.status;
}

async function assertRouteAccess(
  key: string,
  scenario: RouteCase,
  role: TestedRole,
  variant: Variant,
  cookie: string,
  fixture: RouteFixture,
) {
  const status = expectedStatus(role, variant, scenario, fixture.memberRole);
  const response = await exerciseRoute(key, cookie, fixture);
  expect(
    response.status,
    `${key} [${role}, ${variant}] expected ${status}, received ${response.status} (${response.body.code ?? 'response'})`,
  ).toBe(status);
  if (status === 403 || status === 404)
    expect(response.body.code, key).toBe(status === 403 ? 'FORBIDDEN' : 'NOT_FOUND');
  return status;
}

describe('D25 M1 authorization acceptance', () => {
  it('has one scenario and the expected access metadata for every registered route', () => {
    const routes = enumerateAccessRoutes();
    expect(routes.map(({ key }) => key).sort()).toEqual(Object.keys(routeCases).sort());
    for (const { key, metadata, scenario } of routes) {
      expect(metadata?.isPublic, key).toBe(false);
      if (scenario.permission === platform) {
        expect(metadata?.platformAdmin, key).toBe(true);
        expect(metadata?.permission, key).toBeUndefined();
      } else {
        expect(metadata?.platformAdmin, key).toBe(false);
        expect(metadata?.permission, key).toBe(scenario.permission);
      }
    }
  });

  it.each(testedRoles.flatMap((role) => variants.map((variant) => ({ role, variant }))))(
    '$role — $variant on every organization and platform route',
    async ({ role, variant }) => {
      const user =
        role === 'platform_admin'
          ? await member({ platform: true })
          : await member({
              orgId: organizationA,
              roles:
                role === 'member_without_role'
                  ? []
                  : [
                      {
                        role,
                        branchId: role === 'org_owner' || role === 'org_admin' ? null : branchA,
                      },
                    ],
            });
      const orgId = variant === 'other organization' ? organizationB : organizationA;
      const branchId =
        variant === 'own branch'
          ? branchA
          : variant === 'other branch'
            ? otherBranch
            : foreignBranch;
      const fixture = await makeRouteFixture(orgId, branchId);
      for (const { key, scenario } of enumerateAccessRoutes()) {
        await assertRouteAccess(key, scenario, role, variant, user.cookie, fixture);
      }
    },
  );

  it('detects a widened org.update grant in the PATCH /orgs/:orgId sweep (expected 403, received 200)', async () => {
    const { rolePermissions: guardPermissions } = await import('@clinik/shared');
    const grants = guardPermissions.branch_manager;
    const key = `PATCH ${orgPrefix}`;
    const manager = await member({ orgId: organizationA, roles: [managerRole] });
    const fixture = await makeRouteFixture(organizationA, branchA);
    const check = () =>
      assertRouteAccess(
        key,
        routeCases[key],
        'branch_manager',
        'own branch',
        manager.cookie,
        fixture,
      );

    await check();
    expect(grants['org.update']).toBeUndefined();
    try {
      grants['org.update'] = 'O';
      await expect(check()).rejects.toThrow(
        `${key} [branch_manager, own branch] expected 403, received 200`,
      );
    } finally {
      delete grants['org.update'];
    }
    await check();
  });

  it.each([
    { role: 'org_admin', memberRole: 'doctor' },
    { role: 'org_admin', memberRole: 'org_admin' },
    { role: 'org_admin', memberRole: 'org_owner' },
    { role: 'branch_manager', memberRole: 'doctor' },
    { role: 'branch_manager', memberRole: 'branch_manager' },
    { role: 'branch_manager', memberRole: 'org_admin' },
  ] as const)(
    'checks role changes and removal by $role targeting $memberRole',
    async ({ role, memberRole }) => {
      const user = await member({
        orgId: organizationA,
        roles: [fixtureAssignment(role, branchA)],
      });
      const fixture = await makeRouteFixture(organizationA, branchA, memberRole);
      const rankedRoutes = enumerateAccessRoutes().filter(({ scenario }) => scenario.rankedTarget);
      expect(rankedRoutes).toHaveLength(2);
      for (const { key, scenario } of rankedRoutes) {
        const before = await auditRowsForOrg();
        const status = await assertRouteAccess(
          key,
          scenario,
          role,
          'own branch',
          user.cookie,
          fixture,
        );
        const after = await auditRowsForOrg();
        if (status === 403) {
          expect(after).toEqual(before);
        } else if (key.startsWith('DELETE ')) {
          expect(after).toHaveLength(before.length + 2);
          expect(after.slice(before.length)).toMatchObject([
            { action: 'invitation.revoked', metadata: { reason: 'inviter_removed' } },
            { action: 'member.removed' },
          ]);
        } else {
          expect(after).toHaveLength(before.length + 1);
        }
      }
    },
  );

  it('returns 404 with a foreign organization or any foreign resource identifier', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const local = await makeRouteFixture(organizationA, branchA);
    const foreign = await makeRouteFixture(organizationB, foreignBranch);
    const tenantRoutes = enumerateAccessRoutes().filter(({ key }) => key.includes(orgPrefix));
    expect(tenantRoutes.length).toBeGreaterThan(0);
    for (const { key, scenario } of tenantRoutes) {
      const crossOrg = await exerciseRoute(key, owner.cookie, foreign);
      expect(crossOrg.status, key).toBe(404);
      expect(crossOrg.body.code, key).toBe('NOT_FOUND');
      for (const id of scenario.resourceKeys ?? []) {
        const crossResource = await exerciseRoute(key, owner.cookie, {
          ...local,
          [id]: foreign[id],
        });
        expect(crossResource.status, `${key}: ${id}`).toBe(404);
        expect(crossResource.body.code, `${key}: ${id}`).toBe('NOT_FOUND');
      }
    }
  });

  it('denies a branch manager assigning branch_manager at their own branch', async () => {
    const manager = await member({ orgId: organizationA, roles: [managerRole] });
    const target = await member({ orgId: organizationA, roles: [doctorA] });
    await call('put', `${orgPath}/members/${target.id}/roles`, manager.cookie)
      .send({ roles: [managerRole] })
      .expect(403);
    await call('post', `${orgPath}/invitations`, manager.cookie)
      .send({ ...managerRole, email: 'next-manager@clinik.test' })
      .expect(403);
  });

  it('hides every organization route from the platform-only admin', async () => {
    const platformAdmin = await member({ platform: true });
    const fixture = await makeRouteFixture(organizationA, branchA);
    for (const { key } of enumerateAccessRoutes().filter(({ key }) => key.includes(orgPrefix))) {
      const response = await exerciseRoute(key, platformAdmin.cookie, fixture);
      expect(response.status, key).toBe(404);
      expect(response.body.code, key).toBe('NOT_FOUND');
    }
  });

  it.each([
    ['org_owner', 200],
    ['org_admin', 200],
    ['branch_manager', 403],
    ['doctor', 403],
    ['receptionist', 403],
  ] satisfies [StaffRole, number][])('gives %s HTTP %s for audit access', async (role, status) => {
    const user = await member({
      orgId: organizationA,
      roles: [
        {
          role,
          branchId: role === 'org_owner' || role === 'org_admin' ? null : branchA,
        },
      ],
    });
    await call('get', `${orgPath}/audit-logs`, user.cookie).expect(status);
  });
});

describe('M1 audit and invitation pagination', () => {
  const firstInstant = '2026-11-23T10:00:00.123101Z';
  const secondInstant = '2026-11-23T10:00:00.123902Z';
  const cursorFor = (position: unknown) =>
    Buffer.from(JSON.stringify(position)).toString('base64url');

  it('projects safe audit fields, combines filters and pages across equal timestamps', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const patientId = randomUUID();
    const events = await harness.adminPool.query<{ id: string }>(
      `INSERT INTO audit_logs (
        organization_id, occurred_at, actor_user_id, actor_type, action, resource_type,
        resource_id, patient_id, outcome, changed_fields, branch_id, ip, user_agent, metadata
      ) VALUES
        ($1, $5, $3, 'user', 'record.view', 'chart', 'first', $4, 'success',
          ARRAY['title'], $7, '192.0.2.5', 'test-agent', '{"private":"sensitive-value"}'),
        ($1, $6, $3, 'user', 'record.view', 'chart', 'second', $4, 'success',
          ARRAY['title'], $7, '192.0.2.5', 'test-agent', '{"private":"sensitive-value"}'),
        ($1, $6, $3, 'user', 'record.view', 'chart', 'third', $4, 'success',
          ARRAY['title'], $7, '192.0.2.5', 'test-agent', '{"private":"sensitive-value"}'),
        ($1, $6, $3, 'user', 'another.action', 'chart', 'different-action', $4, 'success',
          NULL, NULL, NULL, NULL, '{}'),
        ($2, $6, $3, 'user', 'record.view', 'chart', 'foreign-row', $4, 'success',
          NULL, NULL, NULL, NULL, '{}')
      RETURNING id::text`,
      [organizationA, organizationB, owner.id, patientId, firstInstant, secondInstant, branchA],
    );
    const filters = {
      actorId: owner.id,
      patientId,
      action: 'record.view',
      from: firstInstant,
      to: secondInstant,
    };
    const query = () => call('get', `${orgPath}/audit-logs`, owner.cookie).query(filters);
    const first = await query().query({ limit: 1 }).expect(200);
    expect(first.body.items).toEqual([
      {
        id: events.rows[2].id,
        occurredAt: secondInstant,
        actorUserId: owner.id,
        actorType: 'user',
        actorLabel: 'member',
        actorName: fullName,
        action: 'record.view',
        resourceType: 'chart',
        resourceId: 'third',
        outcome: 'success',
        changedFields: ['title'],
        branchId: branchA,
      },
    ]);
    expect(first.body.nextCursor).toBe(cursorFor([secondInstant, events.rows[2].id]));
    const next = await query().query({ cursor: first.body.nextCursor, limit: 2 }).expect(200);
    expect(next.body.items.map(({ id }: { id: string }) => id)).toEqual([
      events.rows[1].id,
      events.rows[0].id,
    ]);
    expect(next.body.nextCursor).toBeNull();
    const supplied = await query()
      .query({ cursor: cursorFor([secondInstant, events.rows[4].id]) })
      .expect(200);
    expect(supplied.body.items.map(({ id }: { id: string }) => id)).toEqual([
      events.rows[2].id,
      events.rows[1].id,
      events.rows[0].id,
    ]);
    for (const malformed of [
      'not=base64url',
      cursorFor([firstInstant]),
      cursorFor(['2026-02-30T10:00:00Z', '1']),
      cursorFor(['0000-11-23T10:00:00Z', '1']),
      cursorFor([firstInstant, '9223372036854775808']),
      cursorFor([firstInstant, '-1']),
    ]) {
      expect((await query().query({ cursor: malformed }).expect(400)).body.code).toBe(
        'INVALID_CURSOR',
      );
    }
    await query().query({ limit: 101 }).expect(400);
    const bounded = await call('get', `${orgPath}/audit-logs`, owner.cookie)
      .query({ ...filters, from: secondInstant })
      .expect(200);
    expect(bounded.body.items.map(({ id }: { id: string }) => id)).toEqual([
      events.rows[2].id,
      events.rows[1].id,
    ]);
  });

  it('uses a 50-row default audit limit', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    await harness.adminPool.query(
      `INSERT INTO audit_logs (organization_id, actor_type, action, resource_type, outcome)
       SELECT $1, 'system', 'demo.action', 'demo', 'success' FROM generate_series(1, 51)`,
      [organizationA],
    );
    const page = await call('get', `${orgPath}/audit-logs`, owner.cookie).expect(200);
    expect(page.body.items).toHaveLength(50);
    const next = await call('get', `${orgPath}/audit-logs`, owner.cookie)
      .query({ cursor: page.body.nextCursor })
      .expect(200);
    expect(next.body.items).toHaveLength(1);
    expect(next.body.nextCursor).toBeNull();
  });

  it('paginates invitations at equal timestamps and reads status from the query', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const setup = { role: 'doctor', branchId: branchA, invitedBy: owner.id };
    const one = await directInvitation({ ...setup, email: 'one@clinik.test' });
    const two = await directInvitation({ ...setup, email: 'two@clinik.test' });
    await harness.adminPool.query('UPDATE invitations SET created_at = $1 WHERE id IN ($2, $3)', [
      firstInstant,
      one.id,
      two.id,
    ]);
    const query = () => call('get', `${orgPath}/invitations`, owner.cookie);
    const expected = [one.id, two.id].sort();
    const first = await query().query({ limit: 1 }).expect(200);
    expect(first.body.items.map(({ id }: { id: string }) => id)).toEqual([expected[0]]);
    expect(first.body.nextCursor).toBe(cursorFor([firstInstant, expected[0]]));
    const next = await query().query({ cursor: first.body.nextCursor, limit: 1 }).expect(200);
    expect(next.body.items.map(({ id }: { id: string }) => id)).toEqual([expected[1]]);
    expect(next.body.nextCursor).toBeNull();
    const all = await query().query({ status: 'all', cursor: first.body.nextCursor }).expect(200);
    expect(all.body.items.map(({ id }: { id: string }) => id)).toEqual([expected[1]]);
    expect(
      (
        await query()
          .query({ cursor: cursorFor([firstInstant, 'invalid-uuid']) })
          .expect(400)
      ).body.code,
    ).toBe('INVALID_CURSOR');
    expect(
      (
        await call('get', `${orgPath}/audit-logs`, owner.cookie)
          .query({ cursor: first.body.nextCursor })
          .expect(400)
      ).body.code,
    ).toBe('INVALID_CURSOR');
  });

  it('reapplies invitation tenant, branch and status filters to a supplied position', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const manager = await member({ orgId: organizationA, roles: [managerRole] });
    const setup = { role: 'doctor', invitedBy: owner.id };
    const own = await directInvitation({
      ...setup,
      email: 'local-pending@clinik.test',
      branchId: branchA,
    });
    const revoked = await directInvitation({
      ...setup,
      email: 'local-revoked@clinik.test',
      branchId: branchA,
    });
    await directInvitation({ ...setup, email: 'other-branch@clinik.test', branchId: otherBranch });
    const foreign = await directInvitation({
      ...setup,
      orgId: organizationB,
      email: 'foreign-pending@clinik.test',
      branchId: foreignBranch,
    });
    await harness.adminPool.query('UPDATE invitations SET revoked_at = now() WHERE id = $1', [
      revoked.id,
    ]);
    await harness.adminPool.query('UPDATE invitations SET created_at = $1 WHERE id <> $2', [
      firstInstant,
      foreign.id,
    ]);
    await harness.adminPool.query('UPDATE invitations SET created_at = $1 WHERE id = $2', [
      secondInstant,
      foreign.id,
    ]);
    const page = await call('get', `${orgPath}/invitations`, manager.cookie)
      .query({ cursor: cursorFor([secondInstant, foreign.id]), status: 'pending' })
      .expect(200);
    expect(page.body.items.map(({ id }: { id: string }) => id)).toEqual([own.id]);
  });
});
