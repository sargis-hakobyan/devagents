import { existsSync, mkdirSync, readFileSync, writeFileSync, linkSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { DatabaseSync as LegacyDatabase } from 'node:sqlite';
import { AppError } from '../domain/errors.js';
import { PgSession } from './pg-session.js';

const tables = ['projects', 'tasks', 'events', 'requests', 'evidence', 'teams', 'team_revisions', 'dispatch_queue',
  'task_concurrency', 'model_catalogs', 'trackers', 'pull_requests', 'work_item_concurrency', 'workspace_owner',
  'shared_task_handoffs', 'checkpoint_binding', 'execution_settings'];
const loginTables = ['users', 'password_accounts'];
const ordered = new Set(['tasks', 'dispatch_queue', 'pull_requests', 'shared_task_handoffs']);
const identifier = (name: string) => '"' + name.replaceAll('"', '""') + '"';

/** Both the schema and the import marker commit with the rows. A failed import can be retried. */
async function importLegacy(db: PgSession, path: string, selected: string[]) {
  if (!existsSync(path)) return;
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const legacy: LegacyDatabase = new DatabaseSync(path, { readOnly: true });
  try {
    legacy.exec('BEGIN');
    const version = Number(legacy.prepare('PRAGMA user_version').get()!.user_version);
    if (version > 14) throw Error('Legacy workspace was created by a newer DevAgents version');
    if (legacy.prepare('PRAGMA quick_check(1)').get()?.quick_check !== 'ok') throw Error('Legacy database failed its integrity check');
    if (legacy.prepare('PRAGMA foreign_key_check').get()) throw Error('Legacy workspace contains broken references');
    const sourceTables = new Set(legacy.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    const required = selected === tables ? ['projects', 'tasks', 'events', 'requests'] : [];
    if (selected === loginTables && (sourceTables.has('users') || sourceTables.has('password_accounts'))) required.push(...loginTables);
    if (required.some(table => !sourceTables.has(table))) throw Error('Incomplete legacy database schema');
    const owner = process.env.DEVAGENTS_WORKSPACE_ID;
    if (selected === tables && owner && /^[a-f0-9-]{36}$/.test(owner) && sourceTables.has('workspace_owner')) {
      const previous = legacy.prepare('SELECT user_id FROM workspace_owner WHERE singleton=1').get();
      if (previous && previous.user_id !== owner) throw new AppError('workspace_owner_mismatch', 'Legacy workspace belongs to another user', 403);
    }
    const projectIds = new Map<string, string>();
    for (const table of selected) {
      if (!sourceTables.has(table)) continue;
      let columns = legacy.prepare('PRAGMA table_info(' + table + ')').all().map(r => String(r.name));
      let projection = '*';
      if (table === 'execution_settings' && columns.length === 3 && columns.includes('qa_enabled') && columns.includes('version')) {
        projection = "id, json_object('qa_enabled', qa_enabled, 'version', version) AS data";
        columns = ['id', 'data'];
      }
      const targetColumns = ordered.has(table) ? [...columns, 'insertion_order'] : columns;
      const insert = 'INSERT INTO ' + table + '(' + targetColumns.map(identifier).join(',') + ') VALUES ';
      const values: unknown[] = [];
      const groups: string[] = [];
      let bytes = 0;
      const flush = async () => {
        if (groups.length) await db.prepare(insert + groups.join(',')).run(...values);
        values.length = 0;
        groups.length = 0;
        bytes = 0;
      };
      const rows = legacy.prepare('SELECT ' + projection + (ordered.has(table) ? ', rowid AS insertion_order' : '') + ' FROM ' + table + ' ORDER BY rowid').iterate();
      for (const row of rows) {
        if (version < 7 && table === 'projects' && !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(String(row.id))) {
          const previous = String(row.id);
          row.id = randomUUID();
          projectIds.set(previous, row.id);
          const data = JSON.parse(String(row.data));
          row.data = JSON.stringify({ ...data, id: row.id, name: data.name ?? previous });
        } else if (table === 'tasks' && projectIds.has(String(row.project_id))) {
          const previous = row.project_id;
          row.project_id = projectIds.get(String(previous))!;
          const data = JSON.parse(String(row.data));
          data.projectId = row.project_id;
          for (const item of data.plan?.items ?? []) if (item.projectId === previous) item.projectId = row.project_id;
          row.data = JSON.stringify(data);
        }
        const placeholders = targetColumns.map(column => {
          const value = row[column];
          if (typeof value === 'string') bytes += Buffer.byteLength(value);
          return '$' + values.push(value);
        });
        groups.push('(' + placeholders.join(',') + ')');
        if (groups.length >= 100 || bytes >= 1024 * 1024) await flush();
      }
      await flush();
      const key = ordered.has(table) ? 'insertion_order' : ['events', 'evidence'].includes(table) ? 'sequence' : undefined;
      if (key) await db.prepare(`INSERT INTO workspace_counters(stream,value) SELECT $1, COALESCE(max(${key}),0) FROM ${table}
        ON CONFLICT(workspace_id,stream) DO UPDATE SET value=greatest(workspace_counters.value,excluded.value)`).run(table);
    }
  } finally { legacy.close(); }
}

export async function openWorkspace(path: string, component: 'workspace' | 'accounts' = 'workspace') {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const marker = path + '.' + component + '-pg-id';
  const previous = existsSync(marker) ? readFileSync(marker, 'utf8') : undefined;
  const db = await PgSession.open(path);
  try {
    await db.begin();
    const metadata = await db.prepare('SELECT version, store_id FROM schema_versions WHERE component=$1').get(component);
    if (previous !== undefined && metadata?.store_id !== previous) throw new AppError('workspace_store_changed', 'Restore the PostgreSQL database paired with this data volume');
    const version = metadata?.version;
    if (version === undefined) {
      await importLegacy(db, path, component === 'accounts' ? loginTables : tables);
      await db.prepare('INSERT INTO schema_versions(component,version) VALUES ($1,1)').run(component);
    } else if (version !== 1) throw Error('Unsupported PostgreSQL workspace schema version');
    const id = String((await db.prepare('SELECT store_id FROM schema_versions WHERE component=$1').get(component))!.store_id);
    await db.exec('COMMIT');
    if (previous === undefined) {
      const temp = marker + '.' + randomUUID();
      writeFileSync(temp, id, { mode: 0o600, flag: 'wx', flush: true });
      try {
        try { linkSync(temp, marker); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        if (readFileSync(marker, 'utf8') !== id) throw Error('Data volume belongs to a different PostgreSQL workspace');
      } finally { unlinkSync(temp); }
    }
    return db;
  } catch (error) { await db.close(); throw error; }
}
