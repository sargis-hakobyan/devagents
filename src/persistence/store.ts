import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AppError } from '../domain/errors.js';
import { assertTransition } from '../domain/lifecycle.js';
import { TaskInput, type Project, type Task, type TaskEvent, type TaskState, type TaskSummary } from '../domain/schemas.js';
import { environmentSecrets, redact, redactValues } from '../telemetry/redact.js';

export class Store {
  private readonly db: DatabaseSync;
  constructor(path: string, private readonly secrets = environmentSecrets()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > 2) throw new AppError('database_version', 'Database was created by a newer DevAgents version');
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
    if (version < 2) this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE evidence (sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TRIGGER evidence_no_update BEFORE UPDATE ON evidence BEGIN SELECT RAISE(ABORT, 'evidence is append-only'); END;
      CREATE TRIGGER evidence_no_delete BEFORE DELETE ON evidence BEGIN SELECT RAISE(ABORT, 'evidence is append-only'); END;
      PRAGMA user_version=2;
      COMMIT;
    `);
  }
  close(): void { this.db.close(); }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** Task rows feed model prompts: remove secret values only, never rewrite request or plan text. */
  private taskJson(value: unknown): string { return JSON.stringify(redactValues(value, this.secrets)); }
  /** Events and evidence are logs: apply the heuristic credential redaction as well. */
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
  private summarize(t: Task, sequence: number): TaskSummary {
    return {
      id: t.id, projectId: t.projectId, state: t.state, version: t.version, createdAt: t.createdAt, updatedAt: t.updatedAt, sequence,
      request: t.request.length > 200 ? `${t.request.slice(0, 200)}…` : t.request,
      ...(t.mode ? { mode: t.mode } : {}), ...(t.workspace ? { branch: t.workspace.branch } : {}), ...(t.plan ? { items: t.plan.items.length } : {}),
      ...(t.outcome?.commit ? { commit: t.outcome.commit } : {}), ...(t.outcome?.error ? { error: t.outcome.error } : {}),
    };
  }
  /** The list view: no agent snapshots, plans or instructions, which grow to hundreds of kilobytes per task. Newest first, cursor by row id. */
  summaries(options: { limit?: number; before?: number; projectId?: string; state?: TaskState } = {}): { tasks: TaskSummary[]; nextBefore?: number } {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const rows = this.db.prepare('SELECT rowid AS sequence, data FROM tasks WHERE (? IS NULL OR rowid < ?) AND (? IS NULL OR project_id = ?) AND (? IS NULL OR state = ?) ORDER BY rowid DESC LIMIT ?')
      .all(options.before ?? null, options.before ?? null, options.projectId ?? null, options.projectId ?? null, options.state ?? null, options.state ?? null, limit + 1) as { sequence: number; data: string }[];
    const page = rows.slice(0, limit).map(r => this.summarize(JSON.parse(r.data) as Task, Number(r.sequence)));
    return rows.length > limit ? { tasks: page, nextBefore: page[page.length - 1]!.sequence } : { tasks: page };
  }
  /** Measured counts and attention items for the Overview; nothing here is estimated. */
  overview(): { counts: Record<string, number>; attention: TaskSummary[]; active: (TaskSummary & { workItems: Record<string, unknown>[] })[]; recent: TaskSummary[] } {
    const counts: Record<string, number> = {};
    for (const row of this.db.prepare('SELECT state, COUNT(*) AS n FROM tasks GROUP BY state').all() as { state: string; n: number }[]) counts[row.state] = Number(row.n);
    const all = this.summaries({ limit: 200 }).tasks;
    const attention = all.filter(t => t.state === 'awaiting_mode' || t.state === 'awaiting_plan_approval');
    const active = all.filter(t => ['planning', 'ready', 'running', 'validating', 'reviewing', 'committing', 'repairing'].includes(t.state)).map(t => ({ ...t, workItems: this.workItems(t.id) }));
    const recent = all.filter(t => ['completed', 'failed', 'cancelled'].includes(t.state)).slice(0, 8);
    return { counts, attention, active, recent };
  }
  task(id: string): Task {
    const row = this.db.prepare('SELECT data FROM tasks WHERE id=?').get(id);
    if (!row) throw new AppError('not_found', 'Unknown task', 404);
    return JSON.parse(row.data as string) as Task;
  }
  createTask(input: unknown, key: string): Task {
    const parsed = TaskInput.parse(input);
    this.project(parsed.projectId);
    const clean = redactValues(parsed, this.secrets) as typeof parsed;
    const fingerprint = createHash('sha256').update(JSON.stringify(parsed)).digest('hex');
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM requests WHERE key=?').get(key);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new AppError('idempotency_conflict', 'Idempotency key was used with different input', 409);
        return this.task(previous.task_id as string);
      }
      const now = new Date().toISOString();
      const task: Task = { ...clean, id: randomUUID(), runId: randomUUID(), state: clean.mode ? 'planning' : 'awaiting_mode', version: 0, createdAt: now, updatedAt: now };
      this.db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?)').run(task.id, task.projectId, task.state, task.version, this.taskJson(task));
      this.db.prepare('INSERT INTO requests VALUES (?, ?, ?)').run(key, fingerprint, task.id);
      this.append(task, 'user', clean.mode ? 'Task submitted with autonomy mode' : 'Choose autonomous or plan-approval to continue');
      return task;
    });
  }
  transition(id: string, expectedVersion: number, state: TaskState, actor: string, reason: string, patch: Partial<Pick<Task, 'mode' | 'plan' | 'workspace' | 'agents' | 'outcome'>> = {}): Task {
    return this.transaction(() => {
      const task = this.task(id);
      if (task.version !== expectedVersion) throw new AppError('stale_task', 'Task changed; reload before retrying', 409);
      assertTransition(task.state, state);
      const updated: Task = { ...task, ...patch, state, version: task.version + 1, updatedAt: new Date().toISOString() };
      this.db.prepare('UPDATE tasks SET state=?, version=?, data=? WHERE id=?').run(state, updated.version, this.taskJson(updated), id);
      this.append(updated, actor, reason);
      return this.task(id);
    });
  }
  checkpoint(id: string, expectedVersion: number, patch: Partial<Pick<Task, 'workspace' | 'agents' | 'outcome'>>, reason: string): Task {
    return this.transaction(() => {
      const task = this.task(id);
      if (task.version !== expectedVersion) throw new AppError('stale_task', 'Task changed; reload before retrying', 409);
      const updated = { ...task, ...patch, version: task.version + 1, updatedAt: new Date().toISOString() };
      this.db.prepare('UPDATE tasks SET version=?,data=? WHERE id=?').run(updated.version, this.taskJson(updated), id);
      this.append(updated, 'orchestrator', reason);
      return this.task(id);
    });
  }
  record(id: string, kind: string, data: unknown): void {
    this.task(id);
    this.db.prepare('INSERT INTO evidence (task_id,kind,data) VALUES (?,?,?)').run(id, kind, this.json({ at: new Date().toISOString(), data }));
  }
  evidence(id: string, after = 0, limit = 100000): { sequence: number; kind: string; at: string; data: unknown }[] {
    this.task(id);
    return this.db.prepare('SELECT sequence,kind,data FROM evidence WHERE task_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(id, after, limit).map(r => ({ sequence: Number(r.sequence), kind: String(r.kind), ...JSON.parse(String(r.data)) }));
  }
  evidenceEntry(id: string, sequence: number): { sequence: number; kind: string; at: string; data: unknown } {
    this.task(id);
    const row = this.db.prepare('SELECT sequence,kind,data FROM evidence WHERE task_id=? AND sequence=?').get(id, sequence);
    if (!row) throw new AppError('not_found', 'Unknown evidence entry', 404);
    return { sequence: Number(row.sequence), kind: String(row.kind), ...JSON.parse(String(row.data)) };
  }
  workItems(id: string): Record<string, unknown>[] {
    const task = this.task(id);
    const items = new Map<string, Record<string, unknown>>((task.plan?.items ?? []).map(i => [i.id, { itemId: i.id, state: 'pending', agentId: i.assignedAgent, branch: i.branch, dependsOn: i.dependsOn, ownedPaths: i.ownedPaths }]));
    let recorded = false;
    for (const event of this.evidence(id)) {
      if (event.kind !== 'work-item') continue;
      recorded = true;
      const data = event.data as Record<string, unknown>;
      if (typeof data.itemId === 'string' && items.has(data.itemId)) items.set(data.itemId, { ...items.get(data.itemId), ...data, updatedAt: event.at });
    }
    if (!recorded && task.plan?.items.length === 1) for (const item of items.values()) item.state = task.state;
    if (['failed', 'cancelled'].includes(task.state)) for (const item of items.values()) {
      if (!['completed', 'failed', 'cancelled', 'blocked', 'aborted', 'interrupted'].includes(String(item.state))) item.state = task.state === 'cancelled' ? 'cancelled' : item.state === 'pending' ? 'blocked' : 'interrupted';
    }
    return [...items.values()];
  }
  private append(task: Task, actor: string, reason: string): void {
    this.db.prepare('INSERT INTO events (task_id,data) VALUES (?,?)').run(task.id, this.json({ taskId: task.id, runId: task.runId, actor, reason, state: task.state, timestamp: task.updatedAt }));
  }
  events(id: string, after = 0, limit = 100000): TaskEvent[] {
    this.task(id);
    return this.db.prepare('SELECT sequence,data FROM events WHERE task_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(id, after, limit).map(r => ({ ...JSON.parse(r.data as string), sequence: Number(r.sequence) }) as TaskEvent);
  }
  recover(): string[] {
    // Never replay a worker or external effect after restart. Approval waits survive intact.
    const interrupted = this.tasks().filter(t => ['running', 'validating', 'reviewing', 'committing', 'repairing'].includes(t.state) || (t.state === 'planning' && (t.workspace || this.evidence(t.id).some(e => e.kind === 'worktree-intent'))));
    for (const task of interrupted) this.transition(task.id, task.version, 'failed', 'recovery', 'Process interrupted; inspect preserved worktrees and evidence before submitting a new task');
    return interrupted.map(t => t.id);
  }
}
