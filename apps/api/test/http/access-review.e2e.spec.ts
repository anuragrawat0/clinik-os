import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type DatabaseHarness,
  organizationA,
  organizationB,
  startDatabaseHarness,
} from '../db/harness';
import {
  collectControllerRoutes,
  collectMountedRoutes,
  type ExpressLayer,
} from '../helpers/express-routes';
import { AUTH_MAIL_TRANSPORT } from '../../src/modules/notifications/auth-mailer';
import { PasswordService, SessionService, TokenService } from '../../src/modules/identity/core';

const branchA = '20000000-0000-0000-0000-000000000001';
const otherBranch = '20000000-0000-0000-0000-000000000002';
const foreignBranch = '20000000-0000-0000-0000-000000000003';
const orgPath = `/api/v1/orgs/${organizationA}`;
const password = 'Synthetic-staff-passphrase-27';
const fullName = 'Synthetic Reviewer';
const writeHeaders = { 'X-Requested-With': 'XMLHttpRequest', 'X-Request-Id': 'access-review' };

const ownerRole = { role: 'org_owner', branchId: null } as const;
const adminRole = { role: 'org_admin', branchId: null } as const;
const managerRole = { role: 'branch_manager', branchId: branchA } as const;
const doctorA = { role: 'doctor', branchId: branchA } as const;
const receptionistRole = { role: 'receptionist', branchId: branchA } as const;

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';

@Controller('orgs/:orgId/dummy-review')
class DummyOrgController {
  @Get()
  read(): { ok: true } {
    return { ok: true };
  }
}

let harness: DatabaseHarness;
let app: INestApplication;
let tokenService: TokenService;
let passwordHash: string;
let usersCreated = 0;

function call(method: Method, path: string, cookie?: string) {
  const req = request(app.getHttpServer())[method](path).set(writeHeaders);
  return cookie ? req.set('Cookie', cookie) : req;
}

async function createUser(): Promise<{ id: string; email: string }> {
  const email = `access.review.${++usersCreated}@clinik.test`;
  const result = await harness.adminPool.query<{ id: string }>(
    'INSERT INTO users (email, password_hash, full_name, status) VALUES ($1, $2, $3, $4) RETURNING id',
    [email, passwordHash, fullName, 'active'],
  );
  return { id: result.rows[0].id, email };
}

async function member(
  options: { orgId?: string; roles?: readonly { role: string; branchId: string | null }[] } = {},
) {
  const user = await createUser();
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
}): Promise<{ id: string }> {
  const token = tokenService.generate();
  const result = await harness.adminPool.query<{ id: string }>(
    `INSERT INTO invitations (organization_id, email, role, branch_id, token_hash, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + interval '1 hour') RETURNING id`,
    [
      input.orgId ?? organizationA,
      input.email,
      input.role,
      input.branchId,
      token.hash,
      input.invitedBy,
    ],
  );
  return { id: result.rows[0].id };
}

const cursorFor = (position: unknown) =>
  Buffer.from(JSON.stringify(position)).toString('base64url');

async function insertAudit(rows: {
  orgId?: string;
  occurredAt: string;
  actorUserId?: string | null;
  actorType?: 'user' | 'system';
  action?: string;
  resourceId?: string;
  patientId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: string;
}): Promise<string> {
  const result = await harness.adminPool.query<{ id: string }>(
    `INSERT INTO audit_logs (
       organization_id, occurred_at, actor_user_id, actor_type, action, resource_type,
       resource_id, patient_id, outcome, changed_fields, branch_id, ip, user_agent, metadata
     ) VALUES ($1, $2, $3, $4, $5, 'chart', $6, $7, 'success', ARRAY['title'], $8, $9, $10, $11)
     RETURNING id::text`,
    [
      rows.orgId ?? organizationA,
      rows.occurredAt,
      rows.actorUserId ?? null,
      rows.actorType ?? 'user',
      rows.action ?? 'record.view',
      rows.resourceId ?? 'resource',
      rows.patientId ?? null,
      branchA,
      rows.ip ?? null,
      rows.userAgent ?? null,
      rows.metadata ?? '{}',
    ],
  );
  return result.rows[0].id;
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
  configureHttpApp(app);
  await app.init();
  await app.listen(0);
  passwordHash = await app.get(PasswordService).hash(password);
  tokenService = app.get(TokenService);
}, 180_000);

afterAll(async () => {
  vi.unstubAllEnvs();
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

describe('P4 audit log authorization and projection', () => {
  it('permits OO/OA, denies BM/DR/RC with 403 and non-members with 404', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const admin = await member({ orgId: organizationA, roles: [adminRole] });
    const manager = await member({ orgId: organizationA, roles: [managerRole] });
    const doctor = await member({ orgId: organizationA, roles: [doctorA] });
    const receptionist = await member({ orgId: organizationA, roles: [receptionistRole] });
    const outsider = await member();

    await call('get', `${orgPath}/audit-logs`, owner.cookie).expect(200);
    await call('get', `${orgPath}/audit-logs`, admin.cookie).expect(200);
    for (const denied of [manager, doctor, receptionist]) {
      const response = await call('get', `${orgPath}/audit-logs`, denied.cookie).expect(403);
      expect(response.body.code).toBe('FORBIDDEN');
    }
    const hidden = await call('get', `${orgPath}/audit-logs`, outsider.cookie).expect(404);
    expect(hidden.body.code).toBe('NOT_FOUND');
  });

  it('never returns ip, user agent or metadata values', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    await insertAudit({
      occurredAt: '2026-11-23T10:00:00.000001Z',
      actorUserId: owner.id,
      ip: '198.51.100.9',
      userAgent: 'sentinel-user-agent-marker',
      metadata: '{"private":"sentinel-metadata-marker"}',
    });
    const response = await call('get', `${orgPath}/audit-logs`, owner.cookie).expect(200);
    expect(Object.keys(response.body.items[0]).sort()).toEqual(
      [
        'id',
        'occurredAt',
        'actorUserId',
        'actorType',
        'actorLabel',
        'actorName',
        'action',
        'resourceType',
        'resourceId',
        'outcome',
        'changedFields',
        'branchId',
      ].sort(),
    );
    const serialized = JSON.stringify(response.body);
    for (const sentinel of [
      '198.51.100.9',
      'sentinel-user-agent-marker',
      'sentinel-metadata-marker',
    ])
      expect(serialized).not.toContain(sentinel);
  });

  it('resolves clinic and removed members without disclosing outside actors’ names', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const former = await member({ orgId: organizationA, roles: [doctorA] });
    const foreign = await member({ orgId: organizationB, roles: [ownerRole] });
    const formerName = 'Synthetic Removed Staff';
    const foreignName = 'Synthetic Foreign Staff';
    await harness.adminPool.query('UPDATE users SET full_name = $2 WHERE id = $1', [
      former.id,
      formerName,
    ]);
    await harness.adminPool.query('UPDATE users SET full_name = $2 WHERE id = $1', [
      foreign.id,
      foreignName,
    ]);

    const occurredAt = '2026-11-23T10:00:00.000001Z';
    const currentId = await insertAudit({ occurredAt, actorUserId: owner.id });
    const formerId = await insertAudit({ occurredAt, actorUserId: former.id });
    const foreignId = await insertAudit({ occurredAt, actorUserId: foreign.id });
    const systemId = await insertAudit({ occurredAt, actorType: 'system', actorUserId: owner.id });
    await call('delete', `${orgPath}/members/${former.id}`, owner.cookie).expect(204);

    const { body } = await call('get', `${orgPath}/audit-logs`, owner.cookie)
      .query({ action: 'record.view' })
      .expect(200);
    const labels = body.items.map(({ id, actorLabel, actorName }: Record<string, unknown>) => ({
      id,
      actorLabel,
      actorName,
    }));
    expect(labels).toEqual([
      { id: systemId, actorLabel: 'system', actorName: null },
      { id: foreignId, actorLabel: null, actorName: null },
      { id: formerId, actorLabel: 'former_member', actorName: formerName },
      { id: currentId, actorLabel: 'member', actorName: fullName },
    ]);
    expect(JSON.stringify(body)).not.toContain(foreignName);
  });

  it('re-applies org and filters to a supplied position and rejects malformed cursors', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const patientId = randomUUID();
    const first = '2026-11-23T10:00:00.000001Z';
    const second = '2026-11-23T10:00:00.000002Z';
    const third = '2026-11-23T10:00:00.000003Z';
    const a1 = await insertAudit({
      occurredAt: first,
      actorUserId: owner.id,
      patientId,
      resourceId: 'a1',
    });
    const a2 = await insertAudit({
      occurredAt: second,
      actorUserId: owner.id,
      patientId,
      resourceId: 'a2',
    });
    const a3 = await insertAudit({
      occurredAt: third,
      actorUserId: owner.id,
      patientId,
      resourceId: 'a3',
      action: 'other.action',
    });
    const foreign = await insertAudit({
      orgId: organizationB,
      occurredAt: second,
      actorUserId: owner.id,
      patientId,
      resourceId: 'foreign',
    });

    // A cursor from a row excluded by the filter only moves the boundary; the filter still applies.
    const filtered = await call('get', `${orgPath}/audit-logs`, owner.cookie)
      .query({
        actorId: owner.id,
        patientId,
        action: 'record.view',
        cursor: cursorFor([third, a3]),
      })
      .expect(200);
    expect(filtered.body.items.map(({ id }: { id: string }) => id)).toEqual([a2, a1]);
    expect(filtered.body.items.map(({ id }: { id: string }) => id)).not.toContain(foreign);

    // A foreign-org position used on this org must never surface the foreign row.
    const localWithForeignCursor = await call('get', `${orgPath}/audit-logs`, owner.cookie)
      .query({ cursor: cursorFor([second, foreign]) })
      .expect(200);
    expect(localWithForeignCursor.body.items.map(({ id }: { id: string }) => id)).not.toContain(
      foreign,
    );
    for (const id of localWithForeignCursor.body.items.map(({ id }: { id: string }) => id))
      expect([a1, a2, a3]).toContain(id);

    // A local cursor used against Org B returns only Org B rows (never Org A rows).
    const orgB = await member({ orgId: organizationB, roles: [ownerRole] });
    const otherOrg = await call(
      'get',
      `/api/v1/orgs/${organizationB}/audit-logs`,
      orgB.cookie,
    ).query({ cursor: cursorFor([third, a3]) });
    expect([200, 404]).toContain(otherOrg.status);
    for (const id of (otherOrg.body.items ?? []).map(({ id }: { id: string }) => id))
      expect([a1, a2, a3]).not.toContain(id);

    const limitResponse = await call('get', `${orgPath}/audit-logs`, owner.cookie)
      .query({ limit: 101 })
      .expect(400);
    expect(limitResponse.body.code).toBe('INVALID_REQUEST');
    const valid = cursorFor([first, a1]);
    for (const malformed of [
      'not=base64url',
      'a+b/',
      valid.slice(0, -4),
      cursorFor([first]),
      cursorFor(['2026-02-30T10:00:00Z', '1']),
      cursorFor(['0000-11-23T10:00:00Z', '1']),
      cursorFor([first, '9223372036854775808']),
      cursorFor([first, '-1']),
      cursorFor([first, 'not-a-number']),
    ]) {
      const response = await call('get', `${orgPath}/audit-logs`, owner.cookie)
        .query({ cursor: malformed })
        .expect(400);
      expect(response.body.code, malformed).toBe('INVALID_CURSOR');
    }
  });

  it('does not accept an invitation uuid cursor as an audit position', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const invitation = await directInvitation({
      email: 'cross-list@clinik.test',
      role: 'doctor',
      branchId: branchA,
      invitedBy: owner.id,
    });
    const response = await call('get', `${orgPath}/audit-logs`, owner.cookie)
      .query({ cursor: cursorFor(['2026-11-23T10:00:00.000001Z', invitation.id]) })
      .expect(400);
    expect(response.body.code).toBe('INVALID_CURSOR');
  });
});

describe('P5/P8 invitation cursor scope', () => {
  it('pages a branch manager through only their branch and rejects malformed or cross-list cursors', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const manager = await member({ orgId: organizationA, roles: [managerRole] });
    const foreignOwner = await member({ orgId: organizationB, roles: [ownerRole] });
    const [t1, t2, t3, t4, t5, t6] = [
      '2026-11-23T10:00:00.000001Z',
      '2026-11-23T10:00:00.000002Z',
      '2026-11-23T10:00:00.000003Z',
      '2026-11-23T10:00:00.000004Z',
      '2026-11-23T10:00:00.000005Z',
      '2026-11-23T10:00:00.000006Z',
    ];
    const setup = { role: 'doctor', invitedBy: owner.id };
    const ba3 = await directInvitation({ ...setup, email: 'ba3@clinik.test', branchId: branchA });
    const ba2 = await directInvitation({ ...setup, email: 'ba2@clinik.test', branchId: branchA });
    const ba1 = await directInvitation({ ...setup, email: 'ba1@clinik.test', branchId: branchA });
    const ob2 = await directInvitation({
      ...setup,
      email: 'ob2@clinik.test',
      branchId: otherBranch,
    });
    const ob1 = await directInvitation({
      ...setup,
      email: 'ob1@clinik.test',
      branchId: otherBranch,
    });
    const fb = await directInvitation({
      orgId: organizationB,
      email: 'fb@clinik.test',
      role: 'doctor',
      branchId: foreignBranch,
      invitedBy: foreignOwner.id,
    });

    const setCreated = (id: string, value: string) =>
      harness.adminPool.query('UPDATE invitations SET created_at = $1 WHERE id = $2', [value, id]);
    await setCreated(ba1.id, t3);
    await setCreated(ba2.id, t2);
    await setCreated(ba3.id, t1);
    await setCreated(ob1.id, t5);
    await setCreated(ob2.id, t4);
    await setCreated(fb.id, t6);

    const list = (cookie: string, query: Record<string, string> = {}) =>
      call('get', `${orgPath}/invitations`, cookie).query(query);

    // Follow the nextCursor page by page and prove nothing outside branch A appears.
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const response = await list(
        manager.cookie,
        cursor ? { limit: '1', cursor } : { limit: '1' },
      ).expect(200);
      seen.push(...response.body.items.map(({ id }: { id: string }) => id));
      expect((response.body.items as { id: string }[]).every(({ id }) => id !== ob1.id)).toBe(true);
      cursor = response.body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual([ba1.id, ba2.id, ba3.id]);

    // A cursor minted from another org only moves the boundary; branch and org filters still hold.
    const foreignCursor = await list(manager.cookie, {
      cursor: cursorFor([t6, fb.id]),
    }).expect(200);
    expect(foreignCursor.body.items.map(({ id }: { id: string }) => id).sort()).toEqual(
      [ba1.id, ba2.id, ba3.id].sort(),
    );
    expect(foreignCursor.body.items.map(({ id }: { id: string }) => id)).not.toContain(fb.id);

    // Status is re-applied to a supplied position.
    await harness.adminPool.query('UPDATE invitations SET revoked_at = now() WHERE id = $1', [
      ba2.id,
    ]);
    const pending = await list(manager.cookie, {
      status: 'pending',
      cursor: cursorFor([t3, ba1.id]),
    }).expect(200);
    expect(pending.body.items.map(({ id }: { id: string }) => id)).toEqual([ba3.id]);

    // Org B list given an Org A position only returns Org B rows.
    const otherOrg = await call(
      'get',
      `/api/v1/orgs/${organizationB}/invitations`,
      foreignOwner.cookie,
    ).query({ cursor: cursorFor(['2026-11-23T10:00:00.000007Z', ba1.id]) });
    expect([200, 404]).toContain(otherOrg.status);
    expect(otherOrg.body.items.map(({ id }: { id: string }) => id)).toEqual([fb.id]);
    for (const id of otherOrg.body.items.map(({ id }: { id: string }) => id))
      expect([ba1.id, ba2.id, ba3.id]).not.toContain(id);

    const valid = cursorFor([t1, ba3.id]);
    for (const malformed of [
      'not=base64url',
      'a+b/',
      valid.slice(0, -4),
      cursorFor([t1]),
      cursorFor(['2026-02-30T10:00:00Z', ba3.id]),
      cursorFor(['0000-11-23T10:00:00Z', ba3.id]),
      cursorFor([t1, 'invalid-uuid']),
      cursorFor([t1, '1']),
    ]) {
      const response = await list(manager.cookie, { cursor: malformed }).expect(400);
      expect(response.body.code, malformed).toBe('INVALID_CURSOR');
    }

    // An audit (bigint) cursor is rejected by the invitation list.
    await insertAudit({ occurredAt: t6, actorUserId: owner.id });
    const auditCursor = cursorFor([t6, '123']);
    const crossList = await list(manager.cookie, { cursor: auditCursor }).expect(400);
    expect(crossList.body.code).toBe('INVALID_CURSOR');
  });

  it('rejects an audit cursor produced by the API and an invitation cursor produced by the API across lists', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    await insertAudit({ occurredAt: '2026-11-23T10:00:00.000001Z', actorUserId: owner.id });
    await insertAudit({ occurredAt: '2026-11-23T10:00:00.000002Z', actorUserId: owner.id });
    const auditPage = await call('get', `${orgPath}/audit-logs`, owner.cookie)
      .query({ limit: 1 })
      .expect(200);
    expect(auditPage.body.nextCursor).toBeTruthy();
    expect(
      (
        await call('get', `${orgPath}/invitations`, owner.cookie)
          .query({ cursor: auditPage.body.nextCursor })
          .expect(400)
      ).body.code,
    ).toBe('INVALID_CURSOR');

    const invitations: { id: string }[] = [];
    for (const n of [1, 2]) {
      invitations.push(
        await directInvitation({
          email: `cross-${n}@clinik.test`,
          role: 'doctor',
          branchId: branchA,
          invitedBy: owner.id,
        }),
      );
    }
    await harness.adminPool.query('UPDATE invitations SET created_at = $1 WHERE id = $2', [
      '2026-11-23T10:00:00.000001Z',
      invitations[0].id,
    ]);
    await harness.adminPool.query('UPDATE invitations SET created_at = $1 WHERE id = $2', [
      '2026-11-23T10:00:00.000002Z',
      invitations[1].id,
    ]);
    const invitationPage = await call('get', `${orgPath}/invitations`, owner.cookie)
      .query({ limit: 1 })
      .expect(200);
    expect(invitationPage.body.nextCursor).toBeTruthy();
    expect(
      (
        await call('get', `${orgPath}/audit-logs`, owner.cookie)
          .query({ cursor: invitationPage.body.nextCursor })
          .expect(400)
      ).body.code,
    ).toBe('INVALID_CURSOR');
  });
});

describe('P6/P9 no HTTP surface can set is_platform_admin', () => {
  it('rejects the flag on every tenant mutation and leaves users unchanged', async () => {
    const owner = await member({ orgId: organizationA, roles: [ownerRole] });
    const target = await member({ orgId: organizationA, roles: [doctorA] });
    const email = 'flag-probe@clinik.test';

    await call('patch', orgPath, owner.cookie)
      .send({ name: 'Flag Probe', isPlatformAdmin: true })
      .expect(400);
    await call('post', `${orgPath}/branches`, owner.cookie)
      .send({ name: 'Flag Branch', code: 'FLAG', timezone: 'UTC', isPlatformAdmin: true })
      .expect(400);
    await call('post', `${orgPath}/invitations`, owner.cookie)
      .send({ email, role: 'doctor', branchId: branchA, isPlatformAdmin: true })
      .expect(400);
    await call('put', `${orgPath}/members/${target.id}/roles`, owner.cookie)
      .send({ roles: [{ role: 'doctor', branchId: branchA, isPlatformAdmin: true }] })
      .expect(400);

    const { rows } = await harness.adminPool.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM users WHERE is_platform_admin',
    );
    expect(rows[0].count).toBe(0);

    // No controller route even addresses the users table or a platform-admin provisioning surface.
    const routes = collectControllerRoutes(app).map(({ path }) => path);
    expect(routes.some((path) => /(^|\/)users(\/|$)/.test(path))).toBe(false);
    expect(routes.some((path) => path.includes('platform-admin'))).toBe(false);
  });
});

describe('P3 authorization sweep is driven by router enumeration', () => {
  // The exact keys in the D25 scenario table; the acceptance suite asserts live enumeration equals
  // this set, so any newly mounted org route makes that assertion red.
  const knownRouteKeys = [
    'GET /api/v1/orgs/:orgId',
    'PATCH /api/v1/orgs/:orgId',
    'GET /api/v1/orgs/:orgId/branches',
    'POST /api/v1/orgs/:orgId/branches',
    'GET /api/v1/orgs/:orgId/branches/:id',
    'PATCH /api/v1/orgs/:orgId/branches/:id',
    'GET /api/v1/orgs/:orgId/members',
    'GET /api/v1/orgs/:orgId/invitations',
    'POST /api/v1/orgs/:orgId/invitations',
    'DELETE /api/v1/orgs/:orgId/invitations/:id',
    'PUT /api/v1/orgs/:orgId/members/:userId/roles',
    'DELETE /api/v1/orgs/:orgId/members/:userId',
    'POST /api/v1/orgs/:orgId/ownership-transfer',
    'GET /api/v1/orgs/:orgId/audit-logs',
    'GET /api/v1/admin/organizations',
    'POST /api/v1/admin/organizations',
    'GET /api/v1/admin/organizations/:id',
    'PATCH /api/v1/admin/organizations/:id',
    'POST /api/v1/admin/organizations/:id/suspend',
    'POST /api/v1/admin/organizations/:id/reactivate',
    'POST /api/v1/admin/organizations/:id/owner-invitation',
  ];

  let probe: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL = 'postgresql://clinic_app:test@127.0.0.1:1/none';
    const { AppModule } = await import('../../src/app.module');
    const { DATABASE } = await import('../../src/core/db/database.module');
    const { configureHttpApp } = await import('../../src/http-app');
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [DummyOrgController],
    })
      .overrideProvider(DATABASE)
      .useValue({ check: async () => undefined, db: { transaction: async () => null } })
      .compile();
    probe = moduleRef.createNestApplication();
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    configureHttpApp(probe);
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
    await probe.init();
  }, 120_000);

  afterAll(async () => {
    await probe?.close();
  });

  it('picks up a newly mounted org route that the scenario table does not cover', () => {
    const express = probe.getHttpAdapter().getInstance() as { router: { stack: ExpressLayer[] } };
    const keys = collectMountedRoutes(express.router.stack)
      .map(({ key }) => key)
      .filter((key) => /(?:<nested>)?\/api\/v1\/(?:orgs|admin)(?:\/|$)/.test(key))
      .sort();
    const dummy = keys.find((key) => key.endsWith('/orgs/:orgId/dummy-review'));
    expect(dummy).toBeDefined();
    expect(keys.filter((key) => key !== dummy).sort()).toEqual([...knownRouteKeys].sort());
    expect(keys).not.toEqual([...knownRouteKeys].sort());
  });
});
