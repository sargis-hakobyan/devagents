-- Used only by the two-owner Compose example. The service credentials are file mounts.
\set alice_password `cat /run/secrets/alice-db`
\set bob_password `cat /run/secrets/bob-db`
BEGIN;
CREATE ROLE "11111111-1111-4111-8111-111111111111" LOGIN PASSWORD :'alice_password' IN ROLE devagents_worker;
CREATE ROLE "22222222-2222-4222-8222-222222222222" LOGIN PASSWORD :'bob_password' IN ROLE devagents_worker;
COMMIT;
