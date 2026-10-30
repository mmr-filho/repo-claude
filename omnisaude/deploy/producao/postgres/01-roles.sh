#!/bin/sh
# Papéis do cluster dos bancos de tenant em produção (senhas vindas do .env, nunca fixas no código).
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" \
  -v app_pw="$APP_DB_PASSWORD" -v admin_pw="$ADMIN_DB_PASSWORD" -v bi_pw="$BI_DB_PASSWORD" -v repl_pw="$REPLICATION_PASSWORD" <<'SQL'
CREATE ROLE omni_app LOGIN PASSWORD :'app_pw';
CREATE ROLE omni_admin LOGIN PASSWORD :'admin_pw' CREATEDB;
GRANT omni_app TO omni_admin;
CREATE ROLE omni_bi NOLOGIN;
CREATE ROLE omni_bi_reader LOGIN PASSWORD :'bi_pw' IN ROLE omni_bi;
ALTER ROLE omni_bi_reader SET default_transaction_read_only = on;
ALTER ROLE omni_bi_reader SET search_path = bi;
CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD :'repl_pw';
SQL
echo "host replication replicator all scram-sha-256" >> "$PGDATA/pg_hba.conf"
