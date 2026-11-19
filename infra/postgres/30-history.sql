-- Apply once when upgrading an existing task database, and again after adding workspace roles.
BEGIN;
CREATE TABLE IF NOT EXISTS devagents.task_history (
  owner_id uuid NOT NULL,
  stream text NOT NULL CHECK (stream IN ('events','evidence')),
  sequence bigint NOT NULL CHECK (sequence > 0),
  task_id uuid NOT NULL,
  kind text,
  payload json NOT NULL,
  PRIMARY KEY (owner_id, stream, sequence)
);
CREATE INDEX IF NOT EXISTS task_history_page ON devagents.task_history(owner_id, task_id, stream, sequence);
ALTER TABLE devagents.task_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE devagents.task_history FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS own_history ON devagents.task_history;
CREATE POLICY own_history ON devagents.task_history TO devagents_worker
  USING (owner_id::text = current_user) WITH CHECK (owner_id::text = current_user);
GRANT SELECT, INSERT ON devagents.task_history TO devagents_worker;

CREATE TABLE IF NOT EXISTS devagents.workflow_stores (
  owner_id uuid PRIMARY KEY,
  store_id uuid NOT NULL DEFAULT gen_random_uuid()
);
ALTER TABLE devagents.workflow_stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE devagents.workflow_stores FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS own_store ON devagents.workflow_stores;
CREATE POLICY own_store ON devagents.workflow_stores TO devagents_worker
  USING (owner_id::text = current_user) WITH CHECK (owner_id::text = current_user);
GRANT SELECT, INSERT(owner_id) ON devagents.workflow_stores TO devagents_worker;

-- Mastra manages its workflow tables and indexes only in this login's schema.
DO $$
DECLARE worker text; namespace text;
BEGIN
  FOR worker IN SELECT rolname FROM pg_roles
    WHERE rolcanlogin AND rolname ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
      AND pg_has_role(rolname, 'devagents_worker', 'member')
  LOOP
    namespace := 'wf_' || replace(worker,'-','');
    EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I AUTHORIZATION %I', namespace, worker);
    EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC, devagents_worker', namespace);
  END LOOP;
END $$;
COMMIT;
