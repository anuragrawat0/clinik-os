CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              citext NOT NULL UNIQUE,
  password_hash      text,
  full_name          text NOT NULL CHECK (length(full_name) BETWEEN 1 AND 200),
  phone              text,
  is_platform_admin  boolean NOT NULL DEFAULT false,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','disabled')),
  email_verified_at  timestamptz,
  failed_login_count integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until       timestamptz,
  last_login_at      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_active_password_check CHECK (status <> 'active' OR password_hash IS NOT NULL)
);

CREATE TABLE sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash          bytea NOT NULL UNIQUE,
  ip                  inet,
  user_agent          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  idle_expires_at     timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at          timestamptz,
  CONSTRAINT sessions_absolute_expiry_check CHECK (absolute_expires_at > created_at)
);
CREATE INDEX sessions_user_active_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE auth_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('email_verify','password_reset')),
  token_hash  bytea NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_tokens_user_idx ON auth_tokens (user_id, purpose);

CREATE TABLE organizations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  slug             text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{2,62}$'),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  default_timezone text NOT NULL DEFAULT 'UTC',
  currency         char(3) NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE branches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  code            text NOT NULL CHECK (code ~ '^[A-Z0-9-]{2,16}$'),
  timezone        text NOT NULL,
  phone           text,
  email           citext,
  address_line1   text,
  address_line2   text,
  city            text,
  region          text,
  postal_code     text,
  country         char(2),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, code)
);

CREATE TABLE organization_members (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id         uuid NOT NULL REFERENCES users(id),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  joined_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);
CREATE INDEX organization_members_user_idx ON organization_members (user_id);

CREATE TABLE staff_role_assignments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  user_id         uuid NOT NULL,
  role            text NOT NULL CHECK (role IN ('org_owner','org_admin','branch_manager','doctor','receptionist')),
  branch_id       uuid,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, user_id) REFERENCES organization_members (organization_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, branch_id) REFERENCES branches (organization_id, id),
  CONSTRAINT staff_role_assignments_scope_check CHECK ((role IN ('org_owner','org_admin')) = (branch_id IS NULL)),
  UNIQUE NULLS NOT DISTINCT (organization_id, user_id, role, branch_id)
);
CREATE UNIQUE INDEX staff_roles_one_owner_uq ON staff_role_assignments (organization_id) WHERE role = 'org_owner';
CREATE INDEX staff_roles_branch_idx ON staff_role_assignments (organization_id, branch_id, role);
CREATE INDEX staff_roles_user_idx ON staff_role_assignments (user_id);

-- M1 stage: preserve the approved final patient_id column while allowing staff roles only.
-- M6 adds the composite patient FK and expands the role/scope check for patient invitations.
CREATE TABLE invitations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  email           citext NOT NULL,
  role            text NOT NULL CHECK (role IN ('org_owner','org_admin','branch_manager','doctor','receptionist')),
  branch_id       uuid,
  patient_id      uuid,
  token_hash      bytea NOT NULL UNIQUE,
  invited_by      uuid NOT NULL REFERENCES users(id),
  expires_at      timestamptz NOT NULL,
  accepted_at     timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, branch_id) REFERENCES branches (organization_id, id),
  CONSTRAINT invitations_role_scope_check CHECK (
       (role IN ('org_owner','org_admin')                  AND branch_id IS NULL     AND patient_id IS NULL)
    OR (role IN ('branch_manager','doctor','receptionist') AND branch_id IS NOT NULL AND patient_id IS NULL)
  ),
  CONSTRAINT invitations_accept_revoke_check CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);
CREATE UNIQUE INDEX invitations_pending_uq ON invitations
  (organization_id, email, role, branch_id, patient_id)
  NULLS NOT DISTINCT WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE TABLE tenant_counters (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  counter         text NOT NULL CHECK (counter IN ('mrn','invoice','claim')),
  next_value      bigint NOT NULL DEFAULT 1 CHECK (next_value > 0),
  PRIMARY KEY (organization_id, counter)
);

CREATE TABLE audit_logs (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  organization_id uuid,
  branch_id       uuid,
  actor_user_id   uuid,
  actor_type      text NOT NULL CHECK (actor_type IN ('user','system','webhook')),
  actor_roles     text[] NOT NULL DEFAULT '{}',
  action          text NOT NULL,
  resource_type   text NOT NULL,
  resource_id     text,
  patient_id      uuid,
  outcome         text NOT NULL CHECK (outcome IN ('success','denied','error')),
  request_id      text,
  ip              inet,
  user_agent      text,
  changed_fields  text[],
  metadata        jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_org_time_idx ON audit_logs (organization_id, occurred_at DESC);
CREATE INDEX audit_patient_time_idx ON audit_logs (organization_id, patient_id, occurred_at DESC) WHERE patient_id IS NOT NULL;
CREATE INDEX audit_actor_time_idx ON audit_logs (actor_user_id, occurred_at DESC);

SELECT attach_set_updated_at('users'::regclass);
SELECT attach_set_updated_at('organizations'::regclass);
SELECT attach_set_updated_at('branches'::regclass);

SELECT attach_tenant_rls('branches'::regclass);
SELECT attach_tenant_rls('invitations'::regclass);
SELECT attach_tenant_rls('tenant_counters'::regclass);

ALTER TABLE organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_members FORCE ROW LEVEL SECURITY;
CREATE POLICY member_lookup ON organization_members FOR SELECT
  USING (organization_id = app_current_org() OR user_id = app_current_user());
CREATE POLICY member_insert ON organization_members FOR INSERT
  WITH CHECK (organization_id = app_current_org());
CREATE POLICY member_update ON organization_members FOR UPDATE
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());
CREATE POLICY member_delete ON organization_members FOR DELETE
  USING (organization_id = app_current_org());

ALTER TABLE staff_role_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_role_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY staff_role_lookup ON staff_role_assignments FOR SELECT
  USING (organization_id = app_current_org() OR user_id = app_current_user());
CREATE POLICY staff_role_insert ON staff_role_assignments FOR INSERT
  WITH CHECK (organization_id = app_current_org());
CREATE POLICY staff_role_update ON staff_role_assignments FOR UPDATE
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());
CREATE POLICY staff_role_delete ON staff_role_assignments FOR DELETE
  USING (organization_id = app_current_org());

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_read ON audit_logs FOR SELECT
  USING (organization_id = app_current_org());
CREATE POLICY audit_insert ON audit_logs FOR INSERT
  WITH CHECK (organization_id IS NULL OR organization_id = app_current_org());
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

REVOKE UPDATE, DELETE ON audit_logs FROM clinic_app;
GRANT SELECT ON branches TO clinic_worker;
GRANT SELECT, INSERT, UPDATE ON tenant_counters TO clinic_worker;
GRANT SELECT, INSERT ON audit_logs TO clinic_worker;
