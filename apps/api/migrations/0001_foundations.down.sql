REVOKE EXECUTE ON FUNCTION attach_tenant_rls(regclass) FROM clinic_migrator;
DROP FUNCTION IF EXISTS attach_tenant_rls(regclass);
REVOKE EXECUTE ON FUNCTION attach_set_updated_at(regclass) FROM clinic_migrator;
DROP FUNCTION IF EXISTS attach_set_updated_at(regclass);
DROP FUNCTION IF EXISTS forbid_delete();
DROP FUNCTION IF EXISTS forbid_mutation();
DROP FUNCTION IF EXISTS forbid_change_when_frozen();
DROP FUNCTION IF EXISTS set_updated_at();
DROP FUNCTION IF EXISTS app_current_user();
DROP FUNCTION IF EXISTS app_current_org();

ALTER DEFAULT PRIVILEGES FOR ROLE clinic_migrator IN SCHEMA public
  REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM clinic_app;
ALTER DEFAULT PRIVILEGES FOR ROLE clinic_migrator IN SCHEMA public
  REVOKE USAGE, SELECT, UPDATE ON SEQUENCES FROM clinic_app;
REVOKE USAGE ON SCHEMA public FROM clinic_app, clinic_worker;

DROP EXTENSION IF EXISTS pg_trgm RESTRICT;
DROP EXTENSION IF EXISTS btree_gist RESTRICT;
DROP EXTENSION IF EXISTS citext RESTRICT;
DROP EXTENSION IF EXISTS pgcrypto RESTRICT;
