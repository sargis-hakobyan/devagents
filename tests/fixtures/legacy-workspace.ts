import { DatabaseSync } from 'node:sqlite';
import { PgSession } from '../../src/persistence/pg-session.js';

// Construct a synthetic file with the column names and types used by the old releases.
export async function legacyWorkspace(sourcePath: string, path: string, version: number) {
  const source = await PgSession.open(sourcePath);
  const db = new DatabaseSync(path);
  try {
    for (const [table, definition] of Object.entries({
      projects: 'id TEXT PRIMARY KEY, path TEXT, data TEXT',
      tasks: 'id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), state TEXT, version INTEGER, data TEXT',
      events: 'sequence INTEGER PRIMARY KEY, task_id TEXT REFERENCES tasks(id), data TEXT',
      requests: 'key TEXT PRIMARY KEY, fingerprint TEXT, task_id TEXT REFERENCES tasks(id)',
      evidence: 'sequence INTEGER PRIMARY KEY, task_id TEXT REFERENCES tasks(id), kind TEXT, data TEXT',
      ...(version >= 3 ? { teams: 'id TEXT PRIMARY KEY, name TEXT, archived INTEGER, revision INTEGER, created_at TEXT, updated_at TEXT',
        team_revisions: 'team_id TEXT, revision INTEGER, data TEXT, created_at TEXT, reason TEXT' } : {}),
    })) {
      db.exec('CREATE TABLE ' + table + '(' + definition + ')');
      const columns = definition.split(', ').map(c => c.split(' ')[0]!);
      const insert = db.prepare('INSERT INTO ' + table + ' VALUES (' + columns.map(() => '?').join(',') + ')');
      for (const row of await source.prepare('SELECT ' + columns.join(',') + ' FROM ' + table).all()) insert.run(...columns.map(c => row[c] as string | number));
    }
    db.exec('PRAGMA user_version=' + version);
  } finally { db.close(); await source.close(); }
}

export async function legacySnapshot(sourcePath: string, path: string, binary = false) {
  const source = await PgSession.open(sourcePath);
  const legacy = new DatabaseSync(path);
  try {
    legacy.exec('CREATE TABLE mastra_workflow_snapshot(workflow_name TEXT, run_id TEXT, snapshot TEXT, resourceId TEXT)');
    for (const row of await source.prepare('SELECT workflow_name, run_id, snapshot::text, "resourceId" FROM mastra_workflow_snapshot').all()) {
      legacy.prepare(binary ? 'INSERT INTO mastra_workflow_snapshot VALUES(?,?,jsonb(?),?)' : 'INSERT INTO mastra_workflow_snapshot VALUES(?,?,?,?)').run(String(row.workflow_name), String(row.run_id), String(row.snapshot), row.resourceId as string | null);
    }
  } finally { await source.close(); legacy.close(); }
}
