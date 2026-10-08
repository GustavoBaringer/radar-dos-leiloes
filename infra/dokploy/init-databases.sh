#!/bin/sh
set -eu

: "${RADAR_DB_PASSWORD:?RADAR_DB_PASSWORD is required}"
: "${KEYCLOAK_DB_PASSWORD:?KEYCLOAK_DB_PASSWORD is required}"

# psql's :'var' quotes values as SQL literals; fixed role/database names are
# emitted as identifiers. This runs only for a new PostgreSQL data volume.
psql --username "$POSTGRES_USER" --dbname postgres \
  --set=ON_ERROR_STOP=1 \
  --set=radar_password="$RADAR_DB_PASSWORD" \
  --set=keycloak_password="$KEYCLOAK_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE radar_app LOGIN PASSWORD %L', :'radar_password') \gexec
SELECT format('CREATE ROLE keycloak_app LOGIN PASSWORD %L', :'keycloak_password') \gexec
CREATE DATABASE radar OWNER radar_app;
CREATE DATABASE keycloak OWNER keycloak_app;
SQL
