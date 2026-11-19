-- Install once per database as the database administrator, with the services stopped.
-- Apply as a single transaction together with consolidate.sql on upgrade.
SET LOCAL search_path = public;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='devagents_runtime') THEN CREATE ROLE devagents_runtime NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='devagents_accounts') THEN CREATE ROLE devagents_accounts NOLOGIN; END IF;
END $$;

CREATE FUNCTION workspace_context() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('devagents.workspace_id', true), '')::uuid
$$;

CREATE TABLE workspace_counters (
  workspace_id uuid NOT NULL DEFAULT workspace_context(), stream text NOT NULL, value bigint NOT NULL,
  PRIMARY KEY (workspace_id, stream)
);
CREATE FUNCTION next_workspace_number(stream_name text) RETURNS bigint LANGUAGE sql VOLATILE AS $$
  INSERT INTO workspace_counters(stream,value) VALUES (stream_name,1)
  ON CONFLICT(workspace_id,stream) DO UPDATE SET value=workspace_counters.value+1 RETURNING value
$$;


CREATE TABLE projects (
  id TEXT, path TEXT NOT NULL, data TEXT NOT NULL,
  workspace_id uuid NOT NULL DEFAULT workspace_context(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, path)
);
CREATE TABLE tasks (
  id TEXT, project_id TEXT NOT NULL, state TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, insertion_order BIGINT NOT NULL DEFAULT next_workspace_number('tasks'),
  workspace_id uuid NOT NULL DEFAULT workspace_context(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id),
  UNIQUE (workspace_id, insertion_order)
);
CREATE TABLE events (
  sequence BIGINT DEFAULT next_workspace_number('events'), task_id TEXT NOT NULL, data TEXT NOT NULL,
  workspace_id uuid NOT NULL DEFAULT workspace_context(),
  PRIMARY KEY (workspace_id, sequence),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id)
);
CREATE TABLE requests (
  key TEXT, fingerprint TEXT NOT NULL, task_id TEXT NOT NULL,
  workspace_id uuid NOT NULL DEFAULT workspace_context(),
  PRIMARY KEY (workspace_id, key),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id)
);
CREATE TABLE evidence (
  sequence BIGINT DEFAULT next_workspace_number('evidence'), task_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL,
  workspace_id uuid NOT NULL DEFAULT workspace_context(),
  PRIMARY KEY (workspace_id, sequence),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id)
);
CREATE TABLE teams (
  id TEXT, name TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  workspace_id uuid NOT NULL DEFAULT workspace_context(),
  PRIMARY KEY (workspace_id, id)
);
CREATE TABLE team_revisions (
  team_id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, reason TEXT NOT NULL,
  workspace_id uuid NOT NULL DEFAULT workspace_context(),
  PRIMARY KEY (workspace_id, team_id, revision),
  FOREIGN KEY (workspace_id, team_id) REFERENCES teams(workspace_id, id)
);
CREATE TABLE dispatch_queue (
  task_id TEXT, requested INTEGER NOT NULL,
  handled INTEGER NOT NULL DEFAULT 0, requested_version INTEGER NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0, owner TEXT, claimed INTEGER NOT NULL DEFAULT 0,
  queued_at TEXT NOT NULL, heartbeat_at TEXT, blocker TEXT,
  insertion_order BIGINT NOT NULL DEFAULT next_workspace_number('dispatch_queue'),
  workspace_id uuid NOT NULL DEFAULT workspace_context(),
  PRIMARY KEY (workspace_id, task_id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id),
  UNIQUE (workspace_id, insertion_order)
);
CREATE TABLE task_concurrency (
  id INTEGER CHECK (id=1), max_concurrent_tasks INTEGER NOT NULL CHECK (max_concurrent_tasks BETWEEN 1 AND 8), version INTEGER NOT NULL,
  workspace_id uuid NOT NULL DEFAULT workspace_context(),
  PRIMARY KEY (workspace_id, id)
);
CREATE TABLE model_catalogs (
  engine TEXT, data TEXT NOT NULL,
  workspace_id uuid NOT NULL DEFAULT workspace_context(),
  PRIMARY KEY (workspace_id, engine)
);
CREATE TABLE trackers (
  id TEXT, data TEXT NOT NULL,
  workspace_id uuid NOT NULL DEFAULT workspace_context(),
  PRIMARY KEY (workspace_id, id)
);
CREATE TABLE pull_requests (
  task_id TEXT, state TEXT NOT NULL, data TEXT NOT NULL, insertion_order BIGINT NOT NULL DEFAULT next_workspace_number('pull_requests'),
  workspace_id uuid NOT NULL DEFAULT workspace_context(),
  PRIMARY KEY (workspace_id, task_id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id),
  UNIQUE (workspace_id, insertion_order)
);
CREATE TABLE work_item_concurrency (
  id INTEGER CHECK (id=1), concurrency INTEGER NOT NULL CHECK (concurrency BETWEEN 1 AND 8), version INTEGER NOT NULL,
  workspace_id uuid NOT NULL DEFAULT workspace_context(),
  PRIMARY KEY (workspace_id, id)
);
CREATE TABLE workspace_owner (
  singleton INTEGER CHECK (singleton=1), user_id TEXT NOT NULL,
  workspace_id uuid NOT NULL DEFAULT workspace_context(),
  PRIMARY KEY (workspace_id, singleton)
);
CREATE TABLE shared_task_handoffs (
  task_id TEXT, owner_id TEXT NOT NULL, claim_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('held','released','archived')), snapshot TEXT,
  insertion_order BIGINT NOT NULL DEFAULT next_workspace_number('shared_task_handoffs'),
  workspace_id uuid NOT NULL DEFAULT workspace_context(),
  PRIMARY KEY (workspace_id, task_id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id),
  UNIQUE (workspace_id, insertion_order)
);
CREATE TABLE checkpoint_binding (
  singleton INTEGER CHECK(singleton=1), store_id TEXT NOT NULL,
  workspace_id uuid NOT NULL DEFAULT workspace_context(),
  PRIMARY KEY (workspace_id, singleton)
);
CREATE TABLE execution_settings (
  id INTEGER, data TEXT NOT NULL,
  workspace_id uuid NOT NULL DEFAULT workspace_context(),
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX requests_by_task ON requests(workspace_id, task_id);
CREATE INDEX handoffs_by_phase ON shared_task_handoffs(workspace_id, phase, task_id);
CREATE INDEX events_by_task ON events(workspace_id, task_id, sequence);
CREATE INDEX evidence_by_task ON evidence(workspace_id, task_id, sequence);
CREATE FUNCTION reject_history_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'History is append-only and team revisions are immutable'; END $$;
CREATE TRIGGER immutable_events BEFORE UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION reject_history_change();
CREATE TRIGGER immutable_evidence BEFORE UPDATE OR DELETE ON evidence FOR EACH ROW EXECUTE FUNCTION reject_history_change();
CREATE TRIGGER immutable_team_revisions BEFORE UPDATE OR DELETE ON team_revisions FOR EACH ROW EXECUTE FUNCTION reject_history_change();

CREATE TABLE task_runs (
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

CREATE TABLE public.task_history (
  owner_id uuid NOT NULL,
  stream text NOT NULL CHECK (stream IN ('events','evidence')),
  sequence bigint NOT NULL CHECK (sequence > 0),
  task_id uuid NOT NULL,
  kind text,
  payload json NOT NULL,
  PRIMARY KEY (owner_id, stream, sequence)
);
CREATE INDEX task_history_page ON public.task_history(owner_id, task_id, stream, sequence);

CREATE TABLE workflow_stores (owner_id uuid PRIMARY KEY, store_id uuid NOT NULL DEFAULT gen_random_uuid());

-- Run IDs are generated UUIDs. Mastra targets these conflict keys when fencing and resuming a run.
CREATE TABLE mastra_workflow_snapshot (
  workflow_name text NOT NULL, run_id text NOT NULL, "resourceId" text, snapshot jsonb NOT NULL,
  "createdAt" timestamp NOT NULL, "updatedAt" timestamp NOT NULL,
  "createdAtZ" timestamptz DEFAULT now(), "updatedAtZ" timestamptz DEFAULT now(),
  workspace_id uuid NOT NULL DEFAULT workspace_context(), PRIMARY KEY (workflow_name, run_id)
);
CREATE INDEX workflow_by_workspace ON mastra_workflow_snapshot(workspace_id, workflow_name, "createdAt" DESC);
CREATE TABLE mastra_workflow_run_owners (
  "runId" text PRIMARY KEY, generation bigint NOT NULL, "ownerId" text NOT NULL,
  "leaseExpiresAt" bigint, "updatedAt" bigint NOT NULL,
  workspace_id uuid NOT NULL DEFAULT workspace_context()
);
CREATE TABLE schema_versions (
  component text NOT NULL, version integer NOT NULL, store_id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL DEFAULT workspace_context(), PRIMARY KEY (workspace_id,component)
);

-- Accounts form one installation-wide directory. Only the gateway (or standalone service) can read credentials.
CREATE TABLE users (id text PRIMARY KEY, name text NOT NULL, role text NOT NULL CHECK(role='admin'));
CREATE TABLE password_accounts (username text PRIMARY KEY, user_id text NOT NULL UNIQUE REFERENCES users(id), salt text NOT NULL, hash text NOT NULL);
GRANT SELECT, INSERT ON users, password_accounts TO devagents_accounts;
GRANT USAGE ON SCHEMA public TO devagents_runtime, devagents_accounts;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'projects', 'tasks', 'events', 'requests',
    'evidence', 'teams', 'team_revisions', 'dispatch_queue',
    'task_concurrency', 'model_catalogs', 'trackers', 'pull_requests',
    'work_item_concurrency', 'workspace_owner', 'shared_task_handoffs', 'checkpoint_binding',
    'execution_settings', 'workspace_counters', 'mastra_workflow_snapshot', 'mastra_workflow_run_owners',
    'schema_versions'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY workspace_rows ON %I USING (workspace_id=workspace_context()) WITH CHECK (workspace_id=workspace_context())',t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO devagents_runtime',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['task_runs','task_history','workflow_stores'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY workspace_rows ON %I USING (owner_id=workspace_context()) WITH CHECK (owner_id=workspace_context())',t);
  END LOOP;
END $$;
GRANT SELECT, INSERT ON schema_versions TO devagents_accounts;
GRANT SELECT, INSERT(owner_id) ON workflow_stores TO devagents_runtime;
GRANT SELECT, INSERT ON task_history TO devagents_runtime;
GRANT SELECT, INSERT(owner_id,task_id,retry_hash,input_hash,submission), UPDATE(claim_id,claimed_at,result,finished_at) ON task_runs TO devagents_runtime;

CREATE TABLE devagents_migrations (version integer PRIMARY KEY);
INSERT INTO devagents_migrations VALUES (1);
