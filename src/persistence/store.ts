import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AppError } from '../domain/errors.js';
import { assertTransition } from '../domain/lifecycle.js';
import { TaskInput, type Project, type Task, type TaskEvent, type TaskState } from '../domain/schemas.js';
import { environmentSecrets, redact } from '../telemetry/redact.js';

export class Store {
  private readonly db: DatabaseSync;
  constructor(path: string, private readonly secrets = environmentSecrets()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > 1) throw new AppError('database_version', 'Database was created by a newer DevAgents version');
    if (version === 0) this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), state TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), data TEXT NOT NULL);
      CREATE TABLE requests (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id));
      CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
      CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
      PRAGMA user_version=1;
      COMMIT;
    `);
  }
  close(): void { this.db.close(); }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private json(value: unknown): string { return JSON.stringify(redact(value, this.secrets)); }
  registerProject(project: Project): Project {
    const existing = this.projects().find(p => p.id === project.id || p.path === project.path);
    if (existing) {
      if (existing.id === project.id && existing.path === project.path && existing.defaultMode === project.defaultMode) return existing;
      throw new AppError('project_conflict', 'Project ID or path already registered with different settings', 409);
    }
    this.db.prepare('INSERT INTO projects VALUES (?, ?, ?)').run(project.id, project.path, JSON.stringify(project));
    return project;
  }
  projects(): Project[] { return this.db.prepare('SELECT data FROM projects ORDER BY id').all().map(r => JSON.parse(r.data as string) as Project); }
  project(id: string): Project {
    const row = this.db.prepare('SELECT data FROM projects WHERE id=?').get(id);
    if (!row) throw new AppError('not_found', 'Unknown project', 404);
    return JSON.parse(row.data as string) as Project;
  }
  tasks(): Task[] { return this.db.prepare('SELECT data FROM tasks ORDER BY rowid DESC').all().map(r => JSON.parse(r.data as string) as Task); }
  task(id: string): Task {
    const row = this.db.prepare('SELECT data FROM tasks WHERE id=?').get(id);
    if (!row) throw new AppError('not_found', 'Unknown task', 404);
    return JSON.parse(row.data as string) as Task;
  }
  createTask(input: unknown, key: string): Task {
    const parsed = TaskInput.parse(input);
    this.project(parsed.projectId);
    const clean = redact(parsed, this.secrets) as typeof parsed;
    const fingerprint = createHash('sha256').update(JSON.stringify(parsed)).digest('hex');
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM requests WHERE key=?').get(key);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new AppError('idempotency_conflict', 'Idempotency key was used with different input', 409);
        return this.task(previous.task_id as string);
      }
      const now = new Date().toISOString();
      const task: Task = { ...clean, id: randomUUID(), runId: randomUUID(), state: clean.mode ? 'planning' : 'awaiting_mode', version: 0, createdAt: now, updatedAt: now };
      this.db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?)').run(task.id, task.projectId, task.state, task.version, this.json(task));
      this.db.prepare('INSERT INTO requests VALUES (?, ?, ?)').run(key, fingerprint, task.id);
      this.append(task, 'user', clean.mode ? 'Task submitted with autonomy mode' : 'Choose autonomous or plan-approval to continue');
      return task;
    });
  }
  transition(id: string, expectedVersion: number, state: TaskState, actor: string, reason: string, patch: Partial<Pick<Task, 'mode' | 'plan'>> = {}): Task {
    return this.transaction(() => {
      const task = this.task(id);
      if (task.version !== expectedVersion) throw new AppError('stale_task', 'Task changed; reload before retrying', 409);
      assertTransition(task.state, state);
      const updated: Task = { ...task, ...patch, state, version: task.version + 1, updatedAt: new Date().toISOString() };
      this.db.prepare('UPDATE tasks SET state=?, version=?, data=? WHERE id=?').run(state, updated.version, this.json(updated), id);
      this.append(updated, actor, reason);
      return this.task(id);
    });
  }
  private append(task: Task, actor: string, reason: string): void {
    this.db.prepare('INSERT INTO events (task_id,data) VALUES (?,?)').run(task.id, this.json({ taskId: task.id, runId: task.runId, actor, reason, state: task.state, timestamp: task.updatedAt }));
  }
  events(id: string): TaskEvent[] {
    this.task(id);
    return this.db.prepare('SELECT sequence,data FROM events WHERE task_id=? ORDER BY sequence').all(id).map(r => ({ ...JSON.parse(r.data as string), sequence: Number(r.sequence) }) as TaskEvent);
  }
  recover(): string[] {
    // Never replay a worker or external effect after restart. Approval waits survive intact.
    const interrupted = this.tasks().filter(t => ['running', 'validating', 'reviewing', 'repairing'].includes(t.state));
    for (const task of interrupted) this.transition(task.id, task.version, 'failed', 'recovery', 'Process interrupted; inspect preserved worktrees and evidence before submitting a new task');
    return interrupted.map(t => t.id);
  }
}
