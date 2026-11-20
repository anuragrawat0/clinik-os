#!/usr/bin/env bash
set -euo pipefail

: "${DB_NAME:?DB_NAME must be set}"
: "${CLINIC_MIGRATOR_PASSWORD:?CLINIC_MIGRATOR_PASSWORD must be set}"
: "${CLINIC_APP_PASSWORD:?CLINIC_APP_PASSWORD must be set}"
: "${CLINIC_WORKER_PASSWORD:?CLINIC_WORKER_PASSWORD must be set}"

psql --set=ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$DB_NAME" \
  --set=db_name="$DB_NAME" \
  --set=migrator_password="$CLINIC_MIGRATOR_PASSWORD" \
  --set=app_password="$CLINIC_APP_PASSWORD" \
  --set=worker_password="$CLINIC_WORKER_PASSWORD" <<'SQL'
CREATE ROLE clinic_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS
  PASSWORD :'migrator_password';
CREATE ROLE clinic_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS
  PASSWORD :'app_password';
CREATE ROLE clinic_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS
  PASSWORD :'worker_password';

ALTER DATABASE :"db_name" OWNER TO clinic_migrator;
ALTER SCHEMA public OWNER TO clinic_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db_name" TO clinic_migrator, clinic_app, clinic_worker;
GRANT USAGE ON SCHEMA public TO clinic_app, clinic_worker;

-- pg-boss owns only its isolated queue schema; it never receives DDL on public.
CREATE SCHEMA pgboss AUTHORIZATION clinic_worker;
SQL
