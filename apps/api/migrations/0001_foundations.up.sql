CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION app_current_org() RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT nullif(current_setting('app.current_org_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_current_user() RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT nullif(current_setting('app.current_user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION attach_set_updated_at(p_table regclass) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  trigger_name text;
BEGIN
  SELECT relation.relname || '_set_updated_at'
    INTO trigger_name
    FROM pg_class AS relation
   WHERE relation.oid = p_table;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_attribute
     WHERE attrelid = p_table
       AND attname = 'updated_at'
       AND attnum > 0
       AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'table % has no updated_at column', p_table USING ERRCODE = 'check_violation';
  END IF;

  EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s', trigger_name, p_table);
  EXECUTE format(
    'CREATE TRIGGER %I BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
    trigger_name,
    p_table
  );
END
$$;

CREATE OR REPLACE FUNCTION attach_tenant_rls(p_table regclass) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  policy_name text := 'tenant_isolation';
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_attribute
     WHERE attrelid = p_table
       AND attname = 'organization_id'
       AND attnum > 0
       AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'table % has no organization_id column', p_table USING ERRCODE = 'check_violation';
  END IF;

  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', p_table);
  EXECUTE format('DROP POLICY IF EXISTS %I ON %s', policy_name, p_table);
  EXECUTE format(
    'CREATE POLICY %I ON %s USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org())',
    policy_name,
    p_table
  );
END
$$;

CREATE OR REPLACE FUNCTION forbid_change_when_frozen() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  frozen boolean;
BEGIN
  EXECUTE format('SELECT %s FROM (SELECT ($1).*) AS old', TG_ARGV[0]) INTO frozen USING OLD;
  IF frozen THEN
    RAISE EXCEPTION '% row % is immutable', TG_TABLE_NAME, OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END
$$;

CREATE OR REPLACE FUNCTION forbid_delete() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'rows in % cannot be deleted', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END
$$;

GRANT USAGE ON SCHEMA public TO clinic_app, clinic_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE clinic_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO clinic_app;
ALTER DEFAULT PRIVILEGES FOR ROLE clinic_migrator IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO clinic_app;
GRANT EXECUTE ON FUNCTION app_current_org() TO clinic_app, clinic_worker;
GRANT EXECUTE ON FUNCTION app_current_user() TO clinic_app, clinic_worker;
GRANT EXECUTE ON FUNCTION set_updated_at() TO clinic_app, clinic_worker;
GRANT EXECUTE ON FUNCTION forbid_change_when_frozen() TO clinic_app, clinic_worker;
GRANT EXECUTE ON FUNCTION forbid_mutation() TO clinic_app, clinic_worker;
GRANT EXECUTE ON FUNCTION forbid_delete() TO clinic_app, clinic_worker;
REVOKE ALL ON FUNCTION attach_set_updated_at(regclass) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION attach_set_updated_at(regclass) TO clinic_migrator;
REVOKE ALL ON FUNCTION attach_tenant_rls(regclass) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION attach_tenant_rls(regclass) TO clinic_migrator;
