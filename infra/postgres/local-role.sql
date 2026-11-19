\set ON_ERROR_STOP on
\set workspace_password `cat /run/secrets/workspace-db`
BEGIN;
SELECT format('CREATE ROLE devagents_app LOGIN PASSWORD %L', :'workspace_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname='devagents_app') \gexec
GRANT devagents_runtime, devagents_accounts TO devagents_app;
COMMIT;
