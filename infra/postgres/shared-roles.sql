\set ON_ERROR_STOP on
\set workspace_password `cat /run/secrets/workspace-db`
\set gateway_password `cat /run/secrets/gateway-db`
BEGIN;
SELECT format('CREATE ROLE devagents_worker_service LOGIN PASSWORD %L', :'workspace_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname='devagents_worker_service') \gexec
SELECT format('CREATE ROLE devagents_gateway LOGIN PASSWORD %L', :'gateway_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname='devagents_gateway') \gexec
GRANT devagents_runtime TO devagents_worker_service;
GRANT devagents_accounts TO devagents_gateway;
COMMIT;
