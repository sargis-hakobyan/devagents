-- Run as the database administrator, before starting the workspace runtimes.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'devagents_worker') THEN
    CREATE ROLE devagents_worker NOLOGIN;
  END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS devagents;
CREATE TABLE IF NOT EXISTS devagents.task_runs (
  owner_id uuid NOT NULL,
  task_id uuid NOT NULL,
  retry_hash text NOT NULL,
  input_hash text NOT NULL,
  submission json NOT NULL,
  claim_id uuid,
  claimed_at timestamptz,
  result json,
  finished_at timestamptz,
  PRIMARY KEY (owner_id, task_id),
  UNIQUE (owner_id, retry_hash),
  CHECK ((claim_id IS NULL) = (claimed_at IS NULL)),
  CHECK ((result IS NULL) = (finished_at IS NULL)),
  CHECK (result IS NULL OR claim_id IS NOT NULL)
);
ALTER TABLE devagents.task_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE devagents.task_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS own_tasks ON devagents.task_runs;
CREATE POLICY own_tasks ON devagents.task_runs TO devagents_worker
  USING (owner_id::text = current_user) WITH CHECK (owner_id::text = current_user);
GRANT USAGE ON SCHEMA devagents TO devagents_worker;
GRANT SELECT, INSERT (owner_id, task_id, retry_hash, input_hash, submission),
  UPDATE (claim_id, claimed_at, result, finished_at) ON devagents.task_runs TO devagents_worker;
COMMIT;
