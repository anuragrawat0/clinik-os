CREATE TABLE tenant_counters (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  counter         text NOT NULL CHECK (counter IN ('mrn','invoice','claim')),
  next_value      bigint NOT NULL DEFAULT 1 CHECK (next_value > 0),
  PRIMARY KEY (organization_id, counter)
);

SELECT attach_tenant_rls('tenant_counters'::regclass);
GRANT SELECT, INSERT, UPDATE ON tenant_counters TO clinic_worker;

ALTER DEFAULT PRIVILEGES FOR ROLE clinic_migrator IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO clinic_app;
GRANT SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO clinic_app;
