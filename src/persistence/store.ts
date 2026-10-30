import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AppError } from '../domain/errors.js';
import { assertTransition } from '../domain/lifecycle.js';
import { TaskInput, TeamInput, type Project, type Task, type TaskEvent, type TaskState, type TaskSummary, type TaskTeam, type TeamRecord } from '../domain/schemas.js';
import { environmentSecrets, redact, redactValues } from '../telemetry/redact.js';

export class Store {
  private readonly db: DatabaseSync;
  constructor(path: string, private readonly secrets = environmentSecrets()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > 3) throw new AppError('database_version', 'Database was created by a newer DevAgents version');
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
    // Schema 3: saved teams with immutable member revisions. Existing rows are untouched; project
    // default teams and task team references live inside the existing JSON columns.
    if (version < 3) this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE team_revisions (team_id TEXT NOT NULL REFERENCES teams(id), revision INTEGER NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, reason TEXT NOT NULL, PRIMARY KEY (team_id, revision));
      CREATE TRIGGER team_revisions_no_update BEFORE UPDATE ON team_revisions BEGIN SELECT RAISE(ABORT, 'team revisions are immutable'); END;
      CREATE TRIGGER team_revisions_no_delete BEFORE DELETE ON team_revisions BEGIN SELECT RAISE(ABORT, 'team revisions are immutable'); END;
      PRAGMA user_version=3;
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
  projects(): Project[] { return this.db.prepare('SELECT data FROM projects ORDER BY id').all().map(r => ({ version: 0, ...JSON.parse(r.data as string) }) as Project); }
  project(id: string): Project {
    const row = this.db.prepare('SELECT data FROM projects WHERE id=?').get(id);
    if (!row) throw new AppError('not_found', 'Unknown project', 404);
    return { version: 0, ...JSON.parse(row.data as string) } as Project;
  }
  /** Changes a project's default team under an optimistic version check; `null` clears it. */
  setProjectDefaultTeam(projectId: string, teamId: string | null, expectedVersion: number): Project {
    return this.transaction(() => {
      const project = this.project(projectId);
      if ((project.version ?? 0) !== expectedVersion) throw new AppError('stale_project', 'Project settings changed; reload before retrying', 409);
      if (teamId !== null) { const team = this.team(teamId); if (team.archived) throw new AppError('team_archived', `Team "${team.name}" is archived and cannot be a default`, 409); }
      const { defaultTeamId: _, ...rest } = project;
      const updated: Project = { ...rest, ...(teamId ? { defaultTeamId: teamId } : {}), version: (project.version ?? 0) + 1 };
      this.db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify(updated), projectId);
      return updated;
    });
  }

  // Teams: the row carries identity and the current revision number; every revision's content is immutable.
  private teamRow(id: string): { id: string; name: string; archived: number; revision: number; created_at: string; updated_at: string } {
    const row = this.db.prepare('SELECT id, name, archived, revision, created_at, updated_at FROM teams WHERE id=?').get(id);
    if (!row) throw new AppError('not_found', 'Unknown team', 404);
    return row as { id: string; name: string; archived: number; revision: number; created_at: string; updated_at: string };
  }
  teamRevision(id: string, revision: number): TeamRecord {
    const row = this.teamRow(id);
    const rev = this.db.prepare('SELECT data FROM team_revisions WHERE team_id=? AND revision=?').get(id, revision);
    if (!rev) throw new AppError('not_found', `Unknown revision ${revision} of team ${id}`, 404);
    const content = JSON.parse(String(rev.data)) as { name: string; description: string; members: TeamRecord['members'] };
    return { id, revision, archived: Boolean(row.archived), createdAt: row.created_at, updatedAt: row.updated_at, ...content };
  }
  team(id: string): TeamRecord { return this.teamRevision(id, this.teamRow(id).revision); }
  teams(filter: 'active' | 'archived' | 'all' = 'active'): TeamRecord[] {
    const rows = this.db.prepare(`SELECT id FROM teams ${filter === 'all' ? '' : `WHERE archived=${filter === 'archived' ? 1 : 0}`} ORDER BY name, id`).all() as { id: string }[];
    return rows.map(r => this.team(r.id));
  }
  teamRevisions(id: string): { revision: number; createdAt: string; reason: string }[] {
    this.teamRow(id);
    return (this.db.prepare('SELECT revision, created_at, reason FROM team_revisions WHERE team_id=? ORDER BY revision').all(id) as { revision: number; created_at: string; reason: string }[]).map(r => ({ revision: Number(r.revision), createdAt: r.created_at, reason: r.reason }));
  }
  createTeam(input: unknown, reason = 'Team created'): TeamRecord {
    const team = TeamInput.parse(input); const id = randomUUID(); const now = new Date().toISOString();
    return this.transaction(() => {
      this.db.prepare('INSERT INTO teams VALUES (?, ?, 0, 1, ?, ?)').run(id, team.name, now, now);
      this.db.prepare('INSERT INTO team_revisions VALUES (?, 1, ?, ?, ?)').run(id, JSON.stringify(team), now, reason);
      return this.team(id);
    });
  }
  /** Every change is a new immutable revision; a stale `expectedRevision` is a conflict, never an overwrite. */
  updateTeam(id: string, expectedRevision: number, input: unknown, reason = 'Team edited'): TeamRecord {
    const team = TeamInput.parse(input);
    return this.transaction(() => {
      const row = this.teamRow(id);
      if (row.revision !== expectedRevision) throw new AppError('stale_team', `Team changed to revision ${row.revision}; reload before retrying`, 409);
      if (row.archived) throw new AppError('team_archived', 'Archived teams cannot be edited; restore the team first', 409);
      const now = new Date().toISOString(); const revision = row.revision + 1;
      this.db.prepare('INSERT INTO team_revisions VALUES (?, ?, ?, ?, ?)').run(id, revision, JSON.stringify(team), now, reason);
      this.db.prepare('UPDATE teams SET name=?, revision=?, updated_at=? WHERE id=?').run(team.name, revision, now, id);
      return this.team(id);
    });
  }
  setTeamArchived(id: string, expectedRevision: number, archived: boolean): TeamRecord {
    return this.transaction(() => {
      const row = this.teamRow(id);
      if (row.revision !== expectedRevision) throw new AppError('stale_team', `Team changed to revision ${row.revision}; reload before retrying`, 409);
      if (Boolean(row.archived) === archived) return this.team(id);
      const now = new Date().toISOString(); const revision = row.revision + 1; const current = this.teamRevision(id, row.revision);
      this.db.prepare('INSERT INTO team_revisions VALUES (?, ?, ?, ?, ?)').run(id, revision, JSON.stringify({ name: current.name, description: current.description, members: current.members }), now, archived ? 'Team archived' : 'Team restored');
      this.db.prepare('UPDATE teams SET archived=?, revision=?, updated_at=? WHERE id=?').run(archived ? 1 : 0, revision, now, id);
      return this.team(id);
    });
  }
  /** An independent copy: later edits to either team never affect the other. */
  duplicateTeam(id: string, name: string): TeamRecord {
    const source = this.team(id);
    return this.createTeam({ name, description: source.description, members: structuredClone(source.members) }, `Duplicated from team ${id} revision ${source.revision}`);
  }
  tasks(): Task[] { return this.db.prepare('SELECT data FROM tasks ORDER BY rowid DESC').all().map(r => JSON.parse(r.data as string) as Task); }
  private summarize(t: Task, sequence: number): TaskSummary {
    return {
      id: t.id, projectId: t.projectId, state: t.state, version: t.version, createdAt: t.createdAt, updatedAt: t.updatedAt, sequence,
      request: t.request.length > 200 ? `${t.request.slice(0, 200)}…` : t.request,
      ...(t.mode ? { mode: t.mode } : {}), ...(t.workspace ? { branch: t.workspace.branch } : {}), ...(t.plan ? { items: t.plan.items.length } : {}),
      ...(t.outcome?.commit ? { commit: t.outcome.commit } : {}), ...(t.outcome?.error ? { error: t.outcome.error } : {}),
      ...(t.team ? { team: { id: t.team.id, revision: t.team.revision, name: t.team.name } } : {}),
    };
  }
  /** The list view: no agent snapshots, plans or instructions, which grow to hundreds of kilobytes per task. Newest first, cursor by row id. */
  summaries(options: { limit?: number; before?: number; projectId?: string; state?: TaskState; states?: TaskState[] } = {}): { tasks: TaskSummary[]; nextBefore?: number } {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const states = options.states ?? (options.state ? [options.state] : undefined);
    const filter = states ? JSON.stringify(states) : null;
    const rows = this.db.prepare('SELECT rowid AS sequence, data FROM tasks WHERE (? IS NULL OR rowid < ?) AND (? IS NULL OR project_id = ?) AND (? IS NULL OR state IN (SELECT value FROM json_each(?))) ORDER BY rowid DESC LIMIT ?')
      .all(options.before ?? null, options.before ?? null, options.projectId ?? null, options.projectId ?? null, filter, filter, limit + 1) as { sequence: number; data: string }[];
    const page = rows.slice(0, limit).map(r => this.summarize(JSON.parse(r.data) as Task, Number(r.sequence)));
    return rows.length > limit ? { tasks: page, nextBefore: page[page.length - 1]!.sequence } : { tasks: page };
  }
  stateCounts(projectId?: string): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const row of this.db.prepare('SELECT state, COUNT(*) AS n FROM tasks WHERE (? IS NULL OR project_id = ?) GROUP BY state').all(projectId ?? null, projectId ?? null) as { state: string; n: number }[]) counts[row.state] = Number(row.n);
    return counts;
  }
  /** Query each category before limiting it; queued submissions must never hide execution. */
  overview(): { counts: Record<string, number>; attention: TaskSummary[]; active: (TaskSummary & { workItems: Record<string, unknown>[] })[]; recent: TaskSummary[] } {
    const counts = this.stateCounts();
    const attention = this.summaries({ states: ['awaiting_mode', 'awaiting_plan_approval'], limit: 50 }).tasks;
    const executing = this.summaries({ states: ['running', 'validating', 'reviewing', 'committing', 'repairing'], limit: 50 }).tasks;
    const queued = this.summaries({ states: ['planning', 'ready'], limit: 50 }).tasks;
    const active = [...executing, ...queued].sort((a, b) => b.sequence - a.sequence).map(t => ({ ...t, workItems: this.workItems(t.id) }));
    const recent = this.summaries({ states: ['completed', 'failed', 'cancelled'], limit: 8 }).tasks;
    return { counts, attention, active, recent };
  }
  /** Approval is historical evidence, not an inference from the task's present state. */
  planApproval(id: string): { status: 'not-planned' | 'autonomous' | 'awaiting' | 'approved' | 'not-approved'; timestamp?: string } {
    const task = this.task(id);
    if (!task.plan) return { status: 'not-planned' };
    if (task.mode === 'autonomous') return { status: 'autonomous' };
    const row = this.db.prepare(`SELECT data FROM events WHERE task_id=? AND json_extract(data, '$.actor')='user' AND json_extract(data, '$.state')='ready' AND json_extract(data, '$.reason')='Plan explicitly approved' ORDER BY sequence DESC LIMIT 1`).get(id);
    if (row) return { status: 'approved', timestamp: (JSON.parse(String(row.data)) as TaskEvent).timestamp };
    return { status: task.state === 'awaiting_plan_approval' ? 'awaiting' : 'not-approved' };
  }
  task(id: string): Task {
    const row = this.db.prepare('SELECT data FROM tasks WHERE id=?').get(id);
    if (!row) throw new AppError('not_found', 'Unknown task', 404);
    return JSON.parse(row.data as string) as Task;
  }
  /**
   * Creates a task atomically with its frozen team configuration. The idempotency check runs first,
   * so retrying an earlier submission returns the original task even after the team or defaults
   * changed; only a new submission resolves `freeze`, inside the same transaction as the insert.
   */
  createTask(input: unknown, key: string, freeze?: (task: Task) => TaskTeam | undefined): Task {
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
      let task: Task = { ...clean, id: randomUUID(), runId: randomUUID(), state: clean.mode ? 'planning' : 'awaiting_mode', version: 0, createdAt: now, updatedAt: now };
      const team = freeze?.(task);
      if (team) task = { ...task, team, agents: team.members.map(m => ({ ...m, schemaVersion: 1 as const, instructionsFile: 'team', source: `team:${team.id}@${team.revision}` })) };
      this.db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?)').run(task.id, task.projectId, task.state, task.version, this.taskJson(task));
      this.db.prepare('INSERT INTO requests VALUES (?, ?, ?)').run(key, fingerprint, task.id);
      this.append(task, 'user', `${clean.mode ? 'Task submitted with autonomy mode' : 'Choose autonomous or plan-approval to continue'}${team ? ` · team "${team.name}" revision ${team.revision} frozen` : ''}`);
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
