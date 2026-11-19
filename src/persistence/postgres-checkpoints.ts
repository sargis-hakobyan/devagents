import { isDeepStrictEqual } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { workspaceConnection } from './pg-session.js';
import pg from 'pg';
import { MastraCompositeStore } from '@mastra/core/storage';
import { WorkflowsPG } from '@mastra/pg';
import type { Pool } from 'pg';
import { AppError } from '../domain/errors.js';
import type { Store } from './store.js';

async function checkWorkflowTables(pool: Pool) {
  const result = await pool.query(`SELECT count(*) AS tables FROM pg_class WHERE oid IN
    (to_regclass('public.mastra_workflow_snapshot'),to_regclass('public.mastra_workflow_run_owners'))
    AND relrowsecurity AND relforcerowsecurity`);
  if (Number(result.rows[0]?.tables) !== 2) throw new AppError('checkpoint_schema', 'Restore the shared PostgreSQL workflow tables and their row policies');
}

/** Called under the workspace service lock, before recovery or admitting requests. */
export async function openCheckpointStorage(pool: Pool, owner: string, store: Store, dataDir: string) {
  if (await store.workspaceOwnerId() !== owner) throw new AppError('workspace_owner_mismatch', 'Checkpoint storage requires the bound workspace');
  await checkWorkflowTables(pool);
  const bound = await store.checkpointBinding();
  if (!bound) await pool.query('INSERT INTO public.workflow_stores(owner_id) VALUES ($1) ON CONFLICT DO NOTHING', [owner]);
  const result = await pool.query('SELECT store_id FROM public.workflow_stores WHERE owner_id=$1', [owner]);
  const storeId: string | undefined = result.rows[0]?.store_id;
  if (!storeId || (bound && bound !== storeId)) throw new AppError('checkpoint_store_changed', 'Restore the PostgreSQL checkpoint store bound to this workspace');
  const workflows = new WorkflowsPG({ pool, schemaName: 'public' });
  const storage = new MastraCompositeStore({ id: 'devagents-workflows', disableInit: true, domains: { workflows } });
  const legacyPath = join(dataDir, 'workflows.db');
  if (!bound) {
    await importSnapshots(workflows, legacyPath);
    await store.bindCheckpoints(storeId);
  }
  return storage;
}

async function importSnapshots(workflows: WorkflowsPG, path: string) {
  if (!existsSync(path)) return;
  const { DatabaseSync } = await import('node:sqlite');
  const legacy = new DatabaseSync(path, { readOnly: true });
  try {
    for (const row of legacy.prepare('SELECT *, json(snapshot) AS snapshot_json FROM mastra_workflow_snapshot').iterate()) {
      const key = { workflowName: String(row.workflow_name), runId: String(row.run_id) };
      const snapshot = JSON.parse(String(row.snapshot_json));
      const written = await workflows.persistWorkflowSnapshot({
        ...key, snapshot, ...(row.resourceId ? { resourceId: String(row.resourceId) } : {}), expectedStatus: [],
      });
      if (!written && !isDeepStrictEqual(await workflows.loadWorkflowSnapshot(key), snapshot)) {
        throw new AppError('checkpoint_import_conflict', 'Existing PostgreSQL checkpoint differs from the legacy snapshot');
      }
    }
  } finally { legacy.close(); }
}

/** Local and standalone shared services use their domain schema for Mastra as well. */
export function workspaceCheckpoints(store: Store, dataDir: string): MastraCompositeStore {
  const { config, workspaceId } = workspaceConnection(store.legacyPath);
  const pool = new pg.Pool({ ...config, max: 3, allowExitOnIdle: true });
  pool.on('error', () => {});
  const workflows = new WorkflowsPG({ pool, schemaName: 'public' });
  let ready: Promise<void> | undefined;
  return new class extends MastraCompositeStore {
    override init() {
      return ready ??= (async () => {
        const binding = await store.checkpointBinding();
        const id = 'workspace:' + workspaceId;
        if (binding && binding !== id) throw new AppError('checkpoint_store_required', 'This workspace requires its PostgreSQL workflow checkpoints');
        await checkWorkflowTables(pool);
        if (!binding) {
          await importSnapshots(workflows, join(dataDir, 'workflows.db'));
          await store.bindCheckpoints(id);
        }
      })();
    }
    override async close() { try { await ready; } finally { await pool.end(); } }
  }({ id: 'devagents-workflows', domains: { workflows }, disableInit: true });
}
