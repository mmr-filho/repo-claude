-- Papéis do cluster de bancos de tenant (executado uma vez, na criação do cluster).
-- Senhas de desenvolvimento: em produção venha do cofre de segredos.
--   omni_app        dono dos bancos tenant_db_* (aplicação e migrações)
--   omni_admin      provisionamento: CREATE DATABASE para novos tenants
--   omni_bi         grupo sem login com SELECT apenas nas views do schema "bi"
--   omni_bi_reader  login usado pelo BI/Text-to-SQL na réplica de leitura
CREATE ROLE omni_app LOGIN PASSWORD 'omni_app';
CREATE ROLE omni_admin LOGIN PASSWORD 'omni_admin' CREATEDB;
GRANT omni_app TO omni_admin;
CREATE ROLE omni_bi NOLOGIN;
CREATE ROLE omni_bi_reader LOGIN PASSWORD 'omni_bi' IN ROLE omni_bi;
ALTER ROLE omni_bi_reader SET default_transaction_read_only = on;
ALTER ROLE omni_bi_reader SET search_path = bi;
