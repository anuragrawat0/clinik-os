import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  customType,
  foreignKey,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const citext = customType<{ data: string; driverData: string }>({ dataType: () => 'citext' });
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });
const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: citext('email').notNull().unique(),
    passwordHash: text('password_hash'),
    fullName: text('full_name').notNull(),
    phone: text('phone'),
    isPlatformAdmin: boolean('is_platform_admin').notNull().default(false),
    status: text('status').notNull().default('pending'),
    emailVerifiedAt: timestamptz('email_verified_at'),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestamptz('locked_until'),
    lastLoginAt: timestamptz('last_login_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    check('users_full_name_check', sql`length(${table.fullName}) BETWEEN 1 AND 200`),
    check('users_status_check', sql`${table.status} IN ('pending', 'active', 'disabled')`),
    check('users_failed_login_count_check', sql`${table.failedLoginCount} >= 0`),
    check(
      'users_active_password_check',
      sql`${table.status} <> 'active' OR ${table.passwordHash} IS NOT NULL`,
    ),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: bytea('token_hash').notNull().unique(),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    lastSeenAt: timestamptz('last_seen_at').notNull().defaultNow(),
    idleExpiresAt: timestamptz('idle_expires_at').notNull(),
    absoluteExpiresAt: timestamptz('absolute_expires_at').notNull(),
    revokedAt: timestamptz('revoked_at'),
  },
  (table) => [
    check('sessions_absolute_expiry_check', sql`${table.absoluteExpiresAt} > ${table.createdAt}`),
    index('sessions_user_active_idx')
      .on(table.userId)
      .where(sql`${table.revokedAt} IS NULL`),
  ],
);

export const authTokens = pgTable(
  'auth_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: text('purpose').notNull(),
    tokenHash: bytea('token_hash').notNull().unique(),
    expiresAt: timestamptz('expires_at').notNull(),
    consumedAt: timestamptz('consumed_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    check('auth_tokens_purpose_check', sql`${table.purpose} IN ('email_verify', 'password_reset')`),
    index('auth_tokens_user_idx').on(table.userId, table.purpose),
  ],
);

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    status: text('status').notNull().default('active'),
    defaultTimezone: text('default_timezone').notNull().default('UTC'),
    currency: char('currency', { length: 3 }).notNull().default('INR'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    check('organizations_name_check', sql`length(${table.name}) BETWEEN 1 AND 200`),
    check('organizations_slug_check', sql`${table.slug} ~ '^[a-z0-9][a-z0-9-]{2,62}$'`),
    check('organizations_status_check', sql`${table.status} IN ('active', 'suspended')`),
    check('organizations_currency_check', sql`${table.currency} = 'INR'`),
  ],
);

export const branches = pgTable(
  'branches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    name: text('name').notNull(),
    code: text('code').notNull(),
    timezone: text('timezone').notNull(),
    phone: text('phone'),
    email: citext('email'),
    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    city: text('city'),
    region: text('region'),
    postalCode: text('postal_code'),
    country: char('country', { length: 2 }),
    status: text('status').notNull().default('active'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    check('branches_name_check', sql`length(${table.name}) BETWEEN 1 AND 200`),
    check('branches_code_check', sql`${table.code} ~ '^[A-Z0-9-]{2,16}$'`),
    check('branches_status_check', sql`${table.status} IN ('active', 'inactive')`),
    unique('branches_organization_id_id_key').on(table.organizationId, table.id),
    unique('branches_organization_id_code_key').on(table.organizationId, table.code),
  ],
);

export const organizationMembers = pgTable(
  'organization_members',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    status: text('status').notNull().default('active'),
    joinedAt: timestamptz('joined_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.userId] }),
    check('organization_members_status_check', sql`${table.status} IN ('active', 'suspended')`),
    index('organization_members_user_idx').on(table.userId),
  ],
);

export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    email: citext('email').notNull(),
    role: text('role').notNull(),
    branchId: uuid('branch_id'),
    // Kept nullable for the approved final schema; M6 adds its FK and patient-role support.
    patientId: uuid('patient_id'),
    tokenHash: bytea('token_hash').notNull().unique(),
    invitedBy: uuid('invited_by')
      .notNull()
      .references(() => users.id),
    expiresAt: timestamptz('expires_at').notNull(),
    acceptedAt: timestamptz('accepted_at'),
    revokedAt: timestamptz('revoked_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.branchId],
      foreignColumns: [branches.organizationId, branches.id],
      name: 'invitations_organization_id_branch_id_fkey',
    }),
    check(
      'invitations_role_check',
      sql`${table.role} IN ('org_owner', 'org_admin', 'branch_manager', 'doctor', 'receptionist')`,
    ),
    check(
      'invitations_role_scope_check',
      sql`(
        (${table.role} IN ('org_owner', 'org_admin') AND ${table.branchId} IS NULL AND ${table.patientId} IS NULL)
        OR (${table.role} IN ('branch_manager', 'doctor', 'receptionist') AND ${table.branchId} IS NOT NULL AND ${table.patientId} IS NULL)
      )`,
    ),
    check(
      'invitations_accept_revoke_check',
      sql`${table.acceptedAt} IS NULL OR ${table.revokedAt} IS NULL`,
    ),
    // `invitations_pending_uq` is declared in SQL: Drizzle 0.45 cannot model a
    // partial unique index with NULLS NOT DISTINCT.
  ],
);

export const staffRoleAssignments = pgTable(
  'staff_role_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    userId: uuid('user_id').notNull(),
    role: text('role').notNull(),
    branchId: uuid('branch_id'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.userId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.userId],
      name: 'staff_role_assignments_organization_id_user_id_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.organizationId, table.branchId],
      foreignColumns: [branches.organizationId, branches.id],
      name: 'staff_role_assignments_organization_id_branch_id_fkey',
    }),
    check(
      'staff_role_assignments_role_check',
      sql`${table.role} IN ('org_owner', 'org_admin', 'branch_manager', 'doctor', 'receptionist')`,
    ),
    check(
      'staff_role_assignments_scope_check',
      sql`(${table.role} IN ('org_owner', 'org_admin')) = (${table.branchId} IS NULL)`,
    ),
    unique().on(table.organizationId, table.userId, table.role, table.branchId).nullsNotDistinct(),
    uniqueIndex('staff_roles_one_owner_uq')
      .on(table.organizationId)
      .where(sql`${table.role} = 'org_owner'`),
    index('staff_roles_branch_idx').on(table.organizationId, table.branchId, table.role),
    index('staff_roles_user_idx').on(table.userId),
  ],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    occurredAt: timestamptz('occurred_at').notNull().defaultNow(),
    organizationId: uuid('organization_id'),
    branchId: uuid('branch_id'),
    actorUserId: uuid('actor_user_id'),
    actorType: text('actor_type').notNull(),
    actorRoles: text('actor_roles')
      .array()
      .notNull()
      .default(sql`'{}'`),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id'),
    patientId: uuid('patient_id'),
    outcome: text('outcome').notNull(),
    requestId: text('request_id'),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    changedFields: text('changed_fields').array(),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (table) => [
    check('audit_logs_actor_type_check', sql`${table.actorType} IN ('user', 'system', 'webhook')`),
    check('audit_logs_outcome_check', sql`${table.outcome} IN ('success', 'denied', 'error')`),
    index('audit_org_time_idx').on(table.organizationId, table.occurredAt.desc()),
    index('audit_patient_time_idx')
      .on(table.organizationId, table.patientId, table.occurredAt.desc())
      .where(sql`${table.patientId} IS NOT NULL`),
    index('audit_actor_time_idx').on(table.actorUserId, table.occurredAt.desc()),
  ],
);
