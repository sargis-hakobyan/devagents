-- Run with psql as the database administrator, before starting any app processes.
\set ON_ERROR_STOP on
BEGIN;
SELECT pg_advisory_xact_lock(1684371041, 1);
SELECT to_regclass('public.devagents_migrations') IS NULL AS install \gset
\if :install
\ir migrations/0001_shared_public/migration.sql
\ir consolidate.sql
\endif
COMMIT;
