import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';

/** An older installation with overlapping local primary keys and a gateway account directory. */
export async function verifyPublicUpgrade(admin: Pool) {
  const owners = [randomUUID(), randomUUID()];
  const bindings = owners.map(() => randomUUID());
  const legacySchema = (owner: string) => 'wf_' + owner.replaceAll('-', '');
  for (const [index, owner] of owners.entries()) {
    const schema = legacySchema(owner);
    await admin.query(`CREATE SCHEMA ${schema};
      CREATE TABLE ${schema}.projects(id text PRIMARY KEY, path text UNIQUE, data text);
      CREATE TABLE ${schema}.tasks(id text PRIMARY KEY, project_id text REFERENCES ${schema}.projects(id), state text, version int, data text, insertion_order bigint);
      CREATE TABLE ${schema}.events(sequence bigint PRIMARY KEY, task_id text REFERENCES ${schema}.tasks(id), data text);
      CREATE TABLE ${schema}.schema_versions(component text PRIMARY KEY, version int, store_id uuid);
      CREATE TABLE ${schema}.mastra_workflow_snapshot(workflow_name text,run_id text,"resourceId" text,snapshot jsonb,"createdAt" timestamp,"updatedAt" timestamp);
      INSERT INTO ${schema}.projects VALUES ('project','/projects/example','{}');
      INSERT INTO ${schema}.tasks VALUES ('task','project','awaiting_plan_approval',3,'{}',11);
      INSERT INTO ${schema}.events VALUES (7,'task','{}');`);
    await admin.query(`INSERT INTO ${schema}.schema_versions VALUES ('workspace',1,$1)`, [bindings[index]]);
    await admin.query(`INSERT INTO ${schema}.mastra_workflow_snapshot VALUES ('task',$1,NULL,'{"status":"suspended"}',now(),now())`, [randomUUID()]);
  }
  await admin.query(`CREATE SCHEMA devagents_workspace;
    CREATE TABLE devagents_workspace.users (id text PRIMARY KEY, name text, role text);
    INSERT INTO devagents_workspace.users VALUES ('fixture-user','Fixture','admin');
    CREATE TABLE devagents_workspace.unrecognized (id integer);
    CREATE SCHEMA devagents;
    CREATE TABLE devagents.workflow_stores(owner_id uuid PRIMARY KEY,store_id uuid NOT NULL);
    INSERT INTO devagents.workflow_stores VALUES (gen_random_uuid(),gen_random_uuid())`);
  const schemaSql = await readFile('infra/postgres/migrations/0001_shared_public/migration.sql', 'utf8');
  const upgradeSql = await readFile('infra/postgres/consolidate.sql', 'utf8');
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    await client.query(schemaSql);
    await assert.rejects(client.query(upgradeSql), { code: '2BP01' });
    await client.query('ROLLBACK');
    assert.equal((await client.query('SELECT * FROM devagents_workspace.users')).rowCount, 1);
    assert.equal((await client.query(`SELECT * FROM ${legacySchema(owners[0]!)}.tasks`)).rowCount, 1);
    await client.query('DROP TABLE devagents_workspace.unrecognized');
    await client.query('BEGIN');
    await client.query(schemaSql);
    await client.query(upgradeSql);
    await client.query('COMMIT');
    assert.deepEqual((await client.query("SELECT nspname FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema'")).rows, [{ nspname: 'public' }]);
    assert.equal((await client.query('SELECT * FROM public.users')).rowCount, 1);
    assert.equal((await client.query('SELECT * FROM public.workflow_stores')).rowCount, 1);
    for (const [index, owner] of owners.entries()) {
      assert.equal((await client.query('SELECT store_id FROM public.schema_versions WHERE workspace_id=$1', [owner])).rows[0].store_id, bindings[index]);
      assert.equal((await client.query('SELECT sequence FROM public.events WHERE workspace_id=$1', [owner])).rows[0].sequence, '7');
      assert.equal((await client.query('SELECT value FROM public.workspace_counters WHERE workspace_id=$1 AND stream=$2', [owner,'events'])).rows[0].value, '7');
      assert.equal((await client.query("SELECT snapshot->>'status' AS status FROM public.mastra_workflow_snapshot WHERE workspace_id=$1", [owner])).rows[0].status, 'suspended');
    }
  } finally { client.release(); }
  return owners;
}
