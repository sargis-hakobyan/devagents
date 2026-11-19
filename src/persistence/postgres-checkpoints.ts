import { isDeepStrictEqual } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MastraCompositeStore } from '@mastra/core/storage';
import { LibSQLStore } from '@mastra/libsql';
import { WorkflowsPG } from '@mastra/pg';
import type { Pool } from 'pg';
import { AppError } from '../domain/errors.js';
import type { Store } from './store.js';

/** Called under the workspace service lock, before recovery or admitting requests. */
export async function openCheckpointStorage(pool: Pool, owner: string, store: Store, dataDir: string) {
  if (store.workspaceOwnerId() !== owner) throw new AppError('workspace_owner_mismatch', 'Checkpoint storage requires the bound workspace');
  const schemaName = 'wf_' + owner.replaceAll('-', '');
  const schema = await pool.query('SELECT 1 FROM pg_namespace WHERE nspname=$1 AND nspowner=current_user::regrole', [schemaName]);
  if (!schema.rowCount) throw new AppError('checkpoint_schema', 'Apply the workspace history migration before startup');
  const bound = store.checkpointBinding();
  if (!bound) await pool.query('INSERT INTO devagents.workflow_stores(owner_id) VALUES ($1) ON CONFLICT DO NOTHING', [owner]);
  const result = await pool.query('SELECT store_id FROM devagents.workflow_stores WHERE owner_id=$1', [owner]);
  const storeId: string | undefined = result.rows[0]?.store_id;
  if (!storeId || (bound && bound !== storeId)) throw new AppError('checkpoint_store_changed', 'Restore the PostgreSQL checkpoint store bound to this workspace');
  if (bound) {
    const table = await pool.query("SELECT to_regclass(format('%I.mastra_workflow_snapshot', $1::text)) AS name", [schemaName]);
    if (!table.rows[0]?.name) throw new AppError('checkpoint_store_changed', 'Restore the missing PostgreSQL workflow table');
  }
  const workflows = new WorkflowsPG({ pool, schemaName });
  // Initialize only the workflow domain. The workspace login has DDL rights in its own schema.
  await workflows.init();
  const storage = new MastraCompositeStore({ id: 'devagents-workflows', disableInit: true, domains: { workflows } });
  const legacyPath = join(dataDir, 'workflows.db');
  if (!bound && existsSync(legacyPath)) {
    const legacy = new LibSQLStore({ id: 'workflow-import', url: pathToFileURL(legacyPath).href });
    try {
      const source = await legacy.getStore('workflows');
      if (!source) throw new AppError('checkpoint_import', 'Legacy workflow storage could not be opened');
      for (let page = 0;; page++) {
        const { runs } = await source.listWorkflowRuns({ page, perPage: 50 });
        for (const run of runs) {
          const snapshot = typeof run.snapshot === 'string' ? JSON.parse(run.snapshot) : run.snapshot;
          // Insert only. A restart partway through import cannot overwrite an existing snapshot.
          const written = await workflows.persistWorkflowSnapshot({ ...run, snapshot, expectedStatus: [] });
          if (!written && !isDeepStrictEqual(await workflows.loadWorkflowSnapshot(run), snapshot)) {
            throw new AppError('checkpoint_import_conflict', 'Existing PostgreSQL checkpoint differs from the legacy snapshot');
          }
        }
        if (runs.length < 50) break;
      }
    } finally { await legacy.close(); }
  }
  if (!bound) store.bindCheckpoints(storeId);
  return storage;
}
