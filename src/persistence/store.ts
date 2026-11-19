import { projectEvidence } from './evidence-projection.js';
import { openWorkspace } from './workspace-database.js';
import { WorkspacePersistence } from './prisma.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { AppError } from '../domain/errors.js';
import { assertTransition } from '../domain/lifecycle.js';
import { Mode, TaskInput, TeamInput, type Project, type Task, type TaskEvent, type TaskState, type TaskSummary, type TaskTeam, type TeamRecord } from '../domain/schemas.js';
import { environmentSecrets, redact, redactValues } from '../telemetry/redact.js';
import { limitationCount, normalizeLegacyLimitations, redactReportProse } from '../domain/limitations.js';
import { STARTER_TEAM_ID } from '../domain/starter-team.js';
import type { DispatchClaim, DispatchRecord } from '../domain/dispatch.js';
import type { ProjectIntegrations } from '../domain/integrations.js';
import type { PullRequestSnapshot } from '../domain/pull-requests.js';
import type { Tracker } from '../domain/trackers.js';
import type { TaskTicket, TicketRef } from '../domain/tickets.js';
import type { ModelCatalog } from '../domain/model-catalog.js';

export class Store {
  private readonly db: WorkspacePersistence;
  private readonly execution = new AsyncLocalStorage<DispatchClaim>();
  private get workspaceId() { return this.db.workspaceId; }
  private byId(id: string) { return { workspace_id_id: { workspace_id: this.workspaceId, id } }; }
  /** Known secret values (environment heuristic plus configured provider keys); shared with every response and diff path. */
  private constructor(readonly legacyPath: string, readonly secrets: readonly string[]) {
    this.db = new WorkspacePersistence(legacyPath);
  }
  static async open(path: string, secrets: readonly string[] = environmentSecrets()): Promise<Store> {
    await (await openWorkspace(path)).close();
    return new Store(path, secrets);
  }

  async checkpointBinding(): Promise<string | undefined> {
    return (await this.db.prepare('SELECT store_id FROM checkpoint_binding WHERE singleton=1').get())?.store_id as string | undefined;
  }
  async bindCheckpoints(storeId: string): Promise<void> {
    await this.db.prepare('INSERT INTO checkpoint_binding VALUES (1,$1) ON CONFLICT DO NOTHING').run(storeId);
    if (await this.checkpointBinding() !== storeId) throw new AppError('checkpoint_store_changed', 'Restore the PostgreSQL checkpoint store bound to this workspace');
  }
  async historyEnd(stream: 'events' | 'evidence'): Promise<number> {
    const table = stream === 'events' ? 'events' : 'evidence';
    return Number((await this.db.prepare(`SELECT COALESCE(MAX(sequence),0) AS seq FROM ${table}`).get())!.seq);
  }
  async historyBatch(stream: 'events' | 'evidence', after: number, through: number) {
    const select = stream === 'events' ? 'NULL AS kind, data FROM events' : 'kind, data FROM evidence';
    const rows = await this.db.prepare(`SELECT sequence, task_id AS "taskId", ${select}
      WHERE sequence>$1 AND sequence<=$2 ORDER BY sequence LIMIT 32`).all(after, through);
    const batch: { sequence: number; taskId: string; kind: string | null; data: string }[] = [];
    let bytes = 0;
    for (const row of rows) {
      const entry = row as (typeof batch)[number];
      bytes += Buffer.byteLength(entry.data);
      if (batch.length && bytes > 1024 * 1024) break;
      batch.push({ ...entry, sequence: Number(row.sequence) });
    }
    return batch;
  }

  async heldForSharedClaim(id: string): Promise<boolean> {
    return Boolean(await this.db.prepare("SELECT 1 FROM shared_task_handoffs WHERE task_id=$1 AND phase='held'").get(id));
  }
  async sharedHandoff(id: string) {
    return await this.db.prepare(`SELECT h.owner_id AS "ownerId",h.claim_id AS "claimId",h.phase,h.snapshot,r.key AS "retryKey",r.fingerprint
      FROM shared_task_handoffs h JOIN requests r ON r.task_id=h.task_id WHERE h.task_id=$1`).get(id) as
      { ownerId: string; claimId: string; phase: 'held' | 'released' | 'archived'; snapshot: string | null; retryKey: string; fingerprint: string } | undefined;
  }
  async outstandingHandoffs(): Promise<string[]> {
    return (await this.db.prepare(`SELECT h.task_id FROM shared_task_handoffs h JOIN tasks t ON t.id=h.task_id
      WHERE h.phase='held' OR (h.phase='released' AND t.state IN ('completed','failed','cancelled')) ORDER BY h.insertion_order`).all()).map(row => String(row.task_id));
  }
  async advanceHandoff(id: string, ownerId: string, claimId: string, from: 'held' | 'released') {
    const next = from === 'held' ? 'released' : 'archived';
    const changed = await this.db.prepare('UPDATE shared_task_handoffs SET phase=$1, snapshot=NULL WHERE task_id=$2 AND owner_id=$3 AND claim_id=$4 AND phase=$5')
      .run(next, id, ownerId, claimId, from);
    if (changed.changes !== 1) throw new AppError('shared_task_conflict', 'The local workspace handoff has changed', 409);
  }

  async workspaceOwnerId(): Promise<string | undefined> {
    return (await this.db.prepare('SELECT user_id FROM workspace_owner WHERE singleton=1').get())?.user_id as string | undefined;
  }

  /** Bind legacy workspace contents once. A later login change cannot transfer them. */
  async bindWorkspaceOwner(userId: string): Promise<void> {
    await this.transaction(async () => {
      await this.db.prepare('INSERT INTO workspace_owner VALUES (1, $1) ON CONFLICT(workspace_id,singleton) DO NOTHING').run(userId);
      if (await this.workspaceOwnerId() !== userId) throw new AppError('workspace_owner_mismatch', 'Workspace is already assigned to another user', 403);
    });
  }

  async pullRequest(taskId: string): Promise<PullRequestSnapshot | undefined> {
    const row = await this.db.models.pullRequest.findUnique({
      where: { workspace_id_task_id: { workspace_id: this.workspaceId, task_id: taskId } }, select: { data: true },
    });
    return row ? JSON.parse(row.data) as PullRequestSnapshot : undefined;
  }
  async savePullRequest(taskId: string, snapshot: PullRequestSnapshot): Promise<void> {
    const key = { workspace_id: this.workspaceId, task_id: taskId };
    const values = { state: snapshot.state, data: this.json(snapshot) };
    await this.db.models.pullRequest.upsert({ where: { workspace_id_task_id: key }, create: { ...key, ...values }, update: values });
  }
  /** Tasks whose pull request is still open, oldest first. */
  async openPullRequests(): Promise<string[]> {
    const rows = await this.db.models.pullRequest.findMany({ where: { state: 'open' }, orderBy: { insertion_order: 'asc' }, select: { task_id: true } });
    return rows.map(row => row.task_id);
  }
  async trackers(): Promise<Tracker[]> {
    return (await this.db.models.tracker.findMany({ select: { data: true } })).map(row => JSON.parse(row.data) as Tracker).sort((a, b) => a.name.localeCompare(b.name));
  }
  async tracker(id: string): Promise<Tracker> {
    const row = await this.db.models.tracker.findUnique({ where: this.byId(id) });
    if (!row) throw new AppError('tracker_not_found', 'No tool with this id. List them with: devagents tools list', 404);
    return JSON.parse(row.data) as Tracker;
  }
  /** Adds or replaces a tool. Its token never passes through here. */
  async saveTracker(tracker: Tracker): Promise<Tracker> {
    await this.db.models.tracker.upsert({ where: this.byId(tracker.id), create: { workspace_id: this.workspaceId, id: tracker.id, data: JSON.stringify(tracker) }, update: { data: JSON.stringify(tracker) } });
    return tracker;
  }
  async removeTracker(id: string): Promise<void> { await this.db.models.tracker.deleteMany({ where: { workspace_id: this.workspaceId, id } }); }
  async taskConcurrency(): Promise<{ maxConcurrentTasks: number; version: number } | undefined> {
    return await this.db.prepare('SELECT max_concurrent_tasks AS "maxConcurrentTasks", version FROM task_concurrency WHERE id=1').get() as { maxConcurrentTasks: number; version: number } | undefined;
  }
  async setTaskConcurrency(maxConcurrentTasks: number, expectedVersion: number): Promise<void> {
    await this.transaction(async () => {
      if (((await this.taskConcurrency())?.version ?? 0) !== expectedVersion) throw new AppError('stale_settings', 'Task concurrency changed; reload before saving again', 409);
      await this.db.prepare(`INSERT INTO task_concurrency VALUES (1, $1, $2) ON CONFLICT(workspace_id,id) DO UPDATE SET max_concurrent_tasks=excluded.max_concurrent_tasks, version=excluded.version`).run(maxConcurrentTasks, expectedVersion + 1);
    });
  }
  async workItemConcurrency(): Promise<{ concurrency: number; version: number } | undefined> {
    return await this.db.prepare('SELECT concurrency, version FROM work_item_concurrency WHERE id=1').get() as { concurrency: number; version: number } | undefined;
  }
  async setWorkItemConcurrency(concurrency: number, expectedVersion: number): Promise<void> {
    await this.transaction(async () => {
      if (((await this.workItemConcurrency())?.version ?? 0) !== expectedVersion) throw new AppError('stale_settings', 'Subtask concurrency changed; reload before saving again', 409);
      await this.db.prepare('INSERT INTO work_item_concurrency VALUES (1, $1, $2) ON CONFLICT(workspace_id,id) DO UPDATE SET concurrency=excluded.concurrency, version=excluded.version').run(concurrency, expectedVersion + 1);
    });
  }
  /** The model list last loaded from an engine; absent until someone loads it. */
  async modelCatalog(engine: string): Promise<ModelCatalog | undefined> {
    const row = await this.db.models.modelCatalog.findUnique({ where: { workspace_id_engine: { workspace_id: this.workspaceId, engine } } });
    return row ? JSON.parse(row.data) as ModelCatalog : undefined;
  }
  async saveModelCatalog(catalog: ModelCatalog): Promise<void> {
    const key = { workspace_id: this.workspaceId, engine: catalog.engine };
    const data = JSON.stringify(catalog);
    await this.db.models.modelCatalog.upsert({ where: { workspace_id_engine: key }, create: { ...key, data }, update: { data } });
  }
  close() { return this.db.close(); }
  private transaction<T>(fn: () => Promise<T>): Promise<T> { return this.db.write(fn); }
  /** An execution update that must read its current version and write under the same lock. */
  withCurrentTask<T>(id: string, update: (task: Task) => Promise<T>): Promise<T> {
    return this.transaction(async () => {
      await this.assertWriter(id);
      return update(await this.task(id));
    });
  }
  /** Called within the same transaction as submission/approval/cancellation. */
  private async requestDispatchRow(task: Task, force = false): Promise<void> {
    const previous = await this.dispatch(task.id);
    if (previous && !force && previous.requestedVersion >= task.version) return;
    const now = new Date().toISOString();
    await this.db.prepare(`INSERT INTO dispatch_queue(task_id, requested, requested_version, queued_at)
      VALUES ($1, 1, $2, $3) ON CONFLICT(workspace_id,task_id) DO UPDATE SET
      requested=dispatch_queue.requested+1, requested_version=excluded.requested_version,
      queued_at=CASE WHEN dispatch_queue.requested=dispatch_queue.handled AND dispatch_queue.owner IS NULL THEN excluded.queued_at ELSE dispatch_queue.queued_at END`)
      .run(task.id, task.version, now);
  }
  async requestDispatch(id: string, force = false): Promise<void> {
    await this.transaction(async () => {
      const task = await this.task(id);
      if (!['awaiting_mode', 'planning', 'awaiting_plan_approval', 'ready', 'cancelled'].includes(task.state)) return;
      await this.requestDispatchRow(task, force);
    });
  }
  async dispatch(id: string): Promise<DispatchRecord | undefined> {
    return await this.db.prepare(`SELECT task_id AS "taskId", requested, handled, requested_version AS "requestedVersion",
      generation, owner, claimed, queued_at AS "queuedAt", heartbeat_at AS "heartbeatAt", blocker
      FROM dispatch_queue WHERE task_id=$1`).get(id) as DispatchRecord | undefined;
  }
  async pendingDispatches(): Promise<string[]> {
    return (await this.db.prepare(`SELECT q.task_id FROM dispatch_queue q JOIN tasks t ON t.id=q.task_id
      WHERE q.requested>q.handled AND q.owner IS NULL AND q.blocker IS NULL
      AND NOT EXISTS (SELECT 1 FROM shared_task_handoffs h WHERE h.task_id=q.task_id AND h.phase='held')
      AND t.state IN ('awaiting_mode','planning','awaiting_plan_approval','ready','cancelled')
      ORDER BY q.queued_at, q.insertion_order`).all()).map(row => String(row.task_id));
  }
  async claimDispatch(owner: string, excluded: ReadonlySet<string> = new Set()): Promise<DispatchClaim | undefined> {
    return this.transaction(async () => {
      const taskId = (await this.pendingDispatches()).find(id => !excluded.has(id)); if (!taskId) return;
      const row = (await this.db.prepare(`UPDATE dispatch_queue SET owner=$1, generation=generation+1,
        claimed=requested, heartbeat_at=$2 WHERE task_id=$3 AND owner IS NULL AND blocker IS NULL
        RETURNING generation, claimed`).get(owner, new Date().toISOString(), taskId))!;
      const workspaceOwnerId = await this.workspaceOwnerId();
      return { taskId, owner, ...(workspaceOwnerId ? { workspaceOwnerId } : {}), generation: Number(row.generation), sequence: Number(row.claimed) };
    });
  }
  private async assertClaimWorkspace(claim: DispatchClaim): Promise<void> {
    if (claim.workspaceOwnerId !== await this.workspaceOwnerId()) throw new AppError('dispatch_ownership', 'Dispatch belongs to another workspace', 409);
  }
  async finishDispatch(claim: DispatchClaim): Promise<void> {
    await this.assertClaimWorkspace(claim);
    const changed = (await this.db.prepare(`UPDATE dispatch_queue SET handled=CASE WHEN (SELECT state FROM tasks WHERE id=task_id) IN ('completed','failed','cancelled') THEN requested ELSE claimed END, owner=NULL, heartbeat_at=NULL
      WHERE task_id=$1 AND owner=$2 AND generation=$3`).run(claim.taskId, claim.owner, claim.generation)).changes;
    if (!changed) throw new AppError('dispatch_ownership', 'Dispatch ownership changed', 409);
  }

  async withDispatch<T>(claim: DispatchClaim, work: () => T): Promise<T> {
    await this.assertClaim(claim); return this.execution.run(claim, work);
  }
  private async assertClaim(claim: DispatchClaim): Promise<void> {
    await this.assertClaimWorkspace(claim);
    const row = await this.dispatch(claim.taskId);
    if (!row || row.owner !== claim.owner || row.generation !== claim.generation || row.claimed !== claim.sequence || row.blocker) {
      throw new AppError('dispatch_ownership', 'Execution no longer owns this task', 409);
    }
  }
  async assertExecution(id: string): Promise<void> {
    const claim = this.execution.getStore();
    if (!claim || claim.taskId !== id) throw new AppError('dispatch_ownership', 'Execution task identity does not match its claim', 409);
    await this.assertClaim(claim);
  }
  private async assertWriter(id: string): Promise<void> {
    // API/user mutations have no execution context and retain their version/auth checks.
    if (this.execution.getStore()) await this.assertExecution(id);
  }
  async heartbeatDispatch(claim: DispatchClaim): Promise<void> {
    await this.assertClaimWorkspace(claim);
    const changed = (await this.db.prepare('UPDATE dispatch_queue SET heartbeat_at=$1 WHERE task_id=$2 AND owner=$3 AND generation=$4 AND blocker IS NULL')
      .run(new Date().toISOString(), claim.taskId, claim.owner, claim.generation)).changes;
    if (!changed) throw new AppError('dispatch_ownership', 'Execution no longer owns this task', 409);
  }
  /** Only startup reconciliation under the service lock may retire an orphaned claim. No TTL takeover. */
  async recoverDispatch(id: string, blocker?: string): Promise<void> {
    await this.transaction(async () => {
      const task = await this.task(id);
      if (!await this.dispatch(id)) await this.requestDispatchRow(task);
      await this.db.prepare(`UPDATE dispatch_queue SET owner=NULL, heartbeat_at=NULL, generation=generation+1,
        handled=CASE WHEN $1::text IS NOT NULL OR (SELECT state FROM tasks WHERE id=task_id) IN ('completed','failed','cancelled') THEN requested ELSE handled END,
        blocker=$2 WHERE task_id=$3`).run(blocker ?? null, blocker ?? null, id);
    });
  }
  async recoveryBlockers(): Promise<{ taskId: string; message: string }[]> {
    return await this.db.prepare('SELECT task_id AS "taskId", blocker AS message FROM dispatch_queue WHERE blocker IS NOT NULL ORDER BY queued_at').all() as { taskId: string; message: string }[];
  }

  /** Redact display prose separately; preserve code-bearing requests, commands and plan descriptions. */
  private safeTask(task: Task): Task {
    return { ...task, ...(task.plan ? { plan: redactReportProse(task.plan, this.secrets) } : {}), ...(task.outcome ? { outcome: normalizeLegacyLimitations(redactReportProse(task.outcome, this.secrets)) } : {}) };
  }
  private taskJson(value: Task): string { return JSON.stringify(redactValues(this.safeTask(value), this.secrets)); }
  /** Events and evidence are logs: apply the heuristic credential redaction as well. */
  private json(value: unknown): string { return JSON.stringify(redact(value, this.secrets)); }
  async registerProject(project: Project, starterTeamId?: string): Promise<Project> {
    return this.transaction(async () => {
      // An archived project keeps its ID for its history but no longer holds its folder.
      const existing = (await this.projects()).find(p => p.id === project.id || (!p.archivedAt && p.path === project.path));
      if (existing) {
        if (existing.archivedAt) throw new AppError('project_archived', `The ID "${existing.id}" belongs to the archived project "${existing.name}". Restore it or choose another ID.`, 409);
        if (existing.id === project.id && existing.path === project.path && existing.defaultMode === project.defaultMode) return existing;
        throw new AppError('project_conflict', existing.id === project.id ? 'Project ID already registered with different settings' : `This folder is already registered as project "${existing.name}". Use it, or archive it first.`, 409);
      }
      await this.assertNameFree(project.name ?? project.id, project.id, 'Choose another name.');
      if (starterTeamId && !project.defaultTeamId) project = { ...project, defaultTeamId: starterTeamId };
      await this.db.models.project.create({ data: { workspace_id: this.workspaceId, id: project.id, path: project.path, data: JSON.stringify(project) } });
      return project;
    });
  }
  /** Rows written before projects had names read with their ID as the name. */
  private readProject(data: string): Project { const project = JSON.parse(data) as Project; return { version: 0, ...project, name: project.name ?? project.id }; }
  async projects(): Promise<Project[]> { return (await this.db.models.project.findMany({ orderBy: { id: 'asc' }, select: { data: true } })).map(r => this.readProject(r.data as string)); }
  /** A name is unique among active projects, compared without regard to case, so it can stand in for the ID in commands. */
  private async assertNameFree(name: string, exceptId: string, hint: string): Promise<void> {
    const holder = (await this.projects()).find(p => p.id !== exceptId && !p.archivedAt && p.name!.toLowerCase() === name.toLowerCase());
    if (holder) throw new AppError('project_conflict', `An active project is already named "${holder.name}". ${hint}`, 409);
  }
  async setProjectName(projectId: string, name: string, expectedVersion: number): Promise<Project> {
    return this.transaction(async () => {
      const project = await this.project(projectId);
      if ((project.version ?? 0) !== expectedVersion) throw new AppError('stale_project', 'Project settings changed; reload before retrying', 409);
      if (project.name === name) return project;
      if (!project.archivedAt) await this.assertNameFree(name, projectId, 'Choose another name.');
      const updated: Project = { ...project, name, version: (project.version ?? 0) + 1 };
      await this.db.models.project.update({ where: this.byId(projectId), data: { data: JSON.stringify(updated) } });
      return updated;
    });
  }
  async project(id: string): Promise<Project> {
    const row = await this.db.models.project.findUnique({ where: this.byId(id) });
    if (!row) throw new AppError('not_found', 'Unknown project', 404);
    return this.readProject(row.data as string);
  }
  /**
   * Replaces a project's integration settings; secrets never pass through here. The project version
   * is left alone so a connection check cannot make a default-team edit stale.
   */
  async setProjectIntegrations(projectId: string, change: (current: ProjectIntegrations) => ProjectIntegrations): Promise<Project> {
    return this.transaction(async () => {
      const { integrations, ...rest } = await this.project(projectId);
      const next = change(integrations ?? {});
      const updated: Project = { ...rest, ...(Object.keys(next).length ? { integrations: next } : {}) };
      await this.db.models.project.update({ where: this.byId(projectId), data: { data: JSON.stringify(updated) } });
      return updated;
    });
  }
  /**
   * Archives or restores a project under its version. Archiving needs every task of the project to be
   * finished and frees the folder for another registration; the row, its tasks and its ID stay.
   * Restoring takes the folder back, so it is refused while an active project is registered on it.
   */
  async setProjectArchived(projectId: string, archived: boolean, expectedVersion: number): Promise<Project> {
    return this.transaction(async () => {
      const project = await this.project(projectId);
      if ((project.version ?? 0) !== expectedVersion) throw new AppError('stale_project', 'Project settings changed; reload before retrying', 409);
      if (Boolean(project.archivedAt) === archived) return project;
      const { archivedAt: _, ...rest } = project;
      if (archived) {
        const open = Number((await this.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id=$1 AND state NOT IN ('completed','failed','cancelled')").get(projectId))!.n);
        if (open) throw new AppError('project_active', `Finish or cancel the ${open} open task${open === 1 ? '' : 's'} of this project before archiving it.`, 409);
      } else {
        const holder = (await this.projects()).find(p => p.id !== projectId && !p.archivedAt && p.path === project.path);
        if (holder) throw new AppError('project_conflict', `Project "${holder.name}" uses this folder. Archive it first.`, 409);
        await this.assertNameFree(project.name ?? project.id, projectId, 'Rename one of them first.');
      }
      const updated: Project = { ...rest, ...(archived ? { archivedAt: new Date().toISOString() } : {}), version: (project.version ?? 0) + 1 };
      // The path column is unique; an archived row gives its value up so the folder can be registered again.
      await this.db.models.project.update({ where: this.byId(projectId), data: { path: archived ? `archived:${projectId}` : project.path, data: JSON.stringify(updated) } });
      return updated;
    });
  }
  /** Records where each project's folder lives on the user's computer, by the internal path it is attached at. Returns how many records changed. */
  async setProjectHostPaths(folders: Readonly<Record<string, string>>): Promise<number> {
    return this.transaction(async () => {
      let changed = 0;
      for (const project of await this.projects()) {
        const hostPath = folders[project.path];
        if (!hostPath || hostPath === project.hostPath) continue;
        await this.db.models.project.update({ where: this.byId(project.id), data: { data: JSON.stringify({ ...project, hostPath }) } }); changed++;
      }
      return changed;
    });
  }
  /** Changes a project's default team under an optimistic version check; `null` clears it. */
  async setProjectDefaultTeam(projectId: string, teamId: string | null, expectedVersion: number): Promise<Project> {
    return this.transaction(async () => {
      const project = await this.project(projectId);
      if ((project.version ?? 0) !== expectedVersion) throw new AppError('stale_project', 'Project settings changed; reload before retrying', 409);
      if (teamId !== null) { const team = await this.team(teamId); if (team.archived) throw new AppError('team_archived', `Team "${team.name}" is archived and cannot be a default`, 409); }
      const { defaultTeamId: _, ...rest } = project;
      const updated: Project = { ...rest, ...(teamId ? { defaultTeamId: teamId } : {}), version: (project.version ?? 0) + 1 };
      await this.db.models.project.update({ where: this.byId(projectId), data: { data: JSON.stringify(updated) } });
      return updated;
    });
  }

  // Teams: the row carries identity and the current revision number; every revision's content is immutable.
  private async teamRow(id: string): Promise<{ id: string; name: string; archived: number; revision: number; created_at: string; updated_at: string }> {
    const row = await this.db.models.team.findUnique({ where: this.byId(id) });
    if (!row) throw new AppError('not_found', 'Unknown team', 404);
    return row as { id: string; name: string; archived: number; revision: number; created_at: string; updated_at: string };
  }
  async teamRevision(id: string, revision: number): Promise<TeamRecord> {
    const row = await this.teamRow(id);
    const rev = await this.db.models.teamRevision.findUnique({ where: { workspace_id_team_id_revision: { workspace_id: this.workspaceId, team_id: id, revision } }, select: { data: true } });
    if (!rev) throw new AppError('not_found', `Unknown revision ${revision} of team ${id}`, 404);
    const content = JSON.parse(String(rev.data)) as { name: string; description: string; members: TeamRecord['members'] };
    return { id, revision, archived: Boolean(row.archived), createdAt: row.created_at, updatedAt: row.updated_at, ...content };
  }
  async team(id: string): Promise<TeamRecord> { return this.teamRevision(id, (await this.teamRow(id)).revision); }
  async teams(filter: 'active' | 'archived' | 'all' = 'active'): Promise<TeamRecord[]> {
    const rows = await this.db.models.team.findMany({
      where: filter === 'all' ? {} : { archived: Number(filter === 'archived') },
      orderBy: [{ name: 'asc' }, { id: 'asc' }], select: { id: true },
    });
    return Promise.all(rows.map(row => this.team(row.id)));
  }
  async teamRevisions(id: string): Promise<{ revision: number; createdAt: string; reason: string }[]> {
    await this.teamRow(id);
    const revisions = await this.db.models.teamRevision.findMany({ where: { team_id: id }, orderBy: { revision: 'asc' },
      select: { revision: true, created_at: true, reason: true } });
    return revisions.map(row => ({ revision: row.revision, createdAt: row.created_at, reason: row.reason }));
  }
  async createTeam(input: unknown, reason = 'Team created'): Promise<TeamRecord> {
    const team = TeamInput.parse(input); const id = randomUUID(); const now = new Date().toISOString();
    return this.transaction(async () => {
      await this.db.models.team.create({ data: { workspace_id: this.workspaceId, id, name: team.name, revision: 1, created_at: now, updated_at: now } });
      await this.db.models.teamRevision.create({ data: { workspace_id: this.workspaceId, team_id: id, revision: 1, data: JSON.stringify(team), created_at: now, reason } });
      return this.team(id);
    });
  }
  /** Bootstrap once by identity, preserving all edits and explicit project choices on every restart. */
  async ensureStarterTeam(input: unknown, usable: (team: TeamRecord) => boolean): Promise<TeamRecord> {
    const template = TeamInput.parse(input);
    return this.transaction(async () => {
      if (!await this.db.models.team.findUnique({ where: this.byId(STARTER_TEAM_ID), select: { id: true } })) {
        const now = new Date().toISOString();
        await this.db.models.team.create({ data: { workspace_id: this.workspaceId, id: STARTER_TEAM_ID, name: template.name, revision: 1, created_at: now, updated_at: now } });
        await this.db.models.teamRevision.create({ data: { workspace_id: this.workspaceId, team_id: STARTER_TEAM_ID, revision: 1, data: JSON.stringify(template), created_at: now, reason: 'Starter team installed' } });
      }
      const team = await this.team(STARTER_TEAM_ID);
      if (usable(team)) for (const project of await this.projects()) {
        // Version > 0 includes an intentional removal of a default. Never undo that choice.
        if (!project.defaultTeamId && project.version === 0) {
          await this.db.models.project.update({ where: this.byId(project.id), data: { data: JSON.stringify({ ...project, defaultTeamId: team.id, version: 1 }) } });
        }
      }
      return team;
    });
  }
  /** Every change is a new immutable revision; a stale `expectedRevision` is a conflict, never an overwrite. */
  async updateTeam(id: string, expectedRevision: number, input: unknown, reason = 'Team edited'): Promise<TeamRecord> {
    const team = TeamInput.parse(input);
    return this.transaction(async () => {
      const row = await this.teamRow(id);
      if (row.revision !== expectedRevision) throw new AppError('stale_team', `Team changed to revision ${row.revision}; reload before retrying`, 409);
      if (row.archived) throw new AppError('team_archived', 'Archived teams cannot be edited; restore the team first', 409);
      const now = new Date().toISOString(); const revision = row.revision + 1;
      await this.db.models.teamRevision.create({ data: { workspace_id: this.workspaceId, team_id: id, revision, data: JSON.stringify(team), created_at: now, reason } });
      await this.db.models.team.update({ where: this.byId(id), data: { name: team.name, revision, updated_at: now } });
      return this.team(id);
    });
  }
  async setTeamArchived(id: string, expectedRevision: number, archived: boolean): Promise<TeamRecord> {
    return this.transaction(async () => {
      const row = await this.teamRow(id);
      if (row.revision !== expectedRevision) throw new AppError('stale_team', `Team changed to revision ${row.revision}; reload before retrying`, 409);
      if (Boolean(row.archived) === archived) return this.team(id);
      const now = new Date().toISOString(); const revision = row.revision + 1; const current = await this.teamRevision(id, row.revision);
      await this.db.models.teamRevision.create({ data: { workspace_id: this.workspaceId, team_id: id, revision, data: JSON.stringify({ name: current.name, description: current.description, members: current.members }), created_at: now, reason: archived ? 'Team archived' : 'Team restored' } });
      await this.db.models.team.update({ where: this.byId(id), data: { archived: Number(archived), revision, updated_at: now } });
      return this.team(id);
    });
  }
  /** An independent copy: later edits to either team never affect the other. */
  async duplicateTeam(id: string, name: string): Promise<TeamRecord> {
    const source = await this.team(id);
    return this.createTeam({ name, description: source.description, members: structuredClone(source.members) }, `Duplicated from team ${id} revision ${source.revision}`);
  }
  async tasks(): Promise<Task[]> { return (await this.db.models.task.findMany({ orderBy: { insertion_order: 'desc' }, select: { data: true } })).map(r => this.safeTask(JSON.parse(r.data as string) as Task)); }
  private async summarize(t: Task, sequence: number): Promise<TaskSummary> {
    t = this.safeTask(t); const pr = t.state === 'completed' ? await this.pullRequest(t.id) : undefined;
    return {
      id: t.id, projectId: t.projectId, state: t.state, version: t.version, createdAt: t.createdAt, updatedAt: t.updatedAt, sequence,
      request: t.request.length > 200 ? `${t.request.slice(0, 200)}…` : t.request,
      ...(t.mode ? { mode: t.mode } : {}), ...(t.workspace ? { branch: t.workspace.branch } : {}), ...(t.plan ? { items: t.plan.items.length } : {}),
      ...(t.outcome?.commit ? { commit: t.outcome.commit } : {}), ...(t.outcome?.error ? { error: t.outcome.error } : {}),
      ...(t.team ? { team: { id: t.team.id, revision: t.team.revision, name: t.team.name } } : {}), ...(t.ticket ? { ticket: t.ticket } : {}),
      ...(limitationCount(t.outcome) ? { limitations: limitationCount(t.outcome), ...(t.outcome?.limitationOverflow ? { limitationOverflow: t.outcome.limitationOverflow } : {}) } : {}),
      ...(t.followUp ? { roundOf: t.followUp.taskId } : {}),
      ...(pr ? { pullRequest: { number: pr.number, state: pr.state, status: pr.status.text, code: pr.status.code, ...(pr.attention && pr.state === 'open' ? { attention: pr.attention } : {}) } } : {}),
    };
  }
  /** The list view: no agent snapshots, plans or instructions, which grow to hundreds of kilobytes per task. Newest first, cursor by row id. */
  async summaries(options: { limit?: number; before?: number; projectId?: string; state?: TaskState; states?: TaskState[]; /** Only tasks whose pull request is open. */ openPullRequest?: boolean } = {}): Promise<{ tasks: TaskSummary[]; nextBefore?: number }> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const states = options.states ?? (options.state ? [options.state] : undefined);
    const rows = await this.db.models.task.findMany({
      where: {
        ...(options.before !== undefined ? { insertion_order: { lt: options.before } } : {}),
        ...(options.projectId !== undefined ? { project_id: options.projectId } : {}),
        ...(states ? { state: { in: states } } : {}),
        ...(options.openPullRequest ? { pull_requests: { is: { state: 'open' } } } : {}),
      },
      orderBy: { insertion_order: 'desc' }, take: limit + 1, select: { insertion_order: true, data: true },
    });
    const page = await Promise.all(rows.slice(0, limit).map(row => this.summarize(JSON.parse(row.data) as Task, Number(row.insertion_order))));
    return rows.length > limit ? { tasks: page, nextBefore: page[page.length - 1]!.sequence } : { tasks: page };
  }
  async stateCounts(projectId?: string): Promise<Record<string, number>> {
    const groups = await this.db.models.task.groupBy({ by: ['state'], where: projectId === undefined ? {} : { project_id: projectId }, _count: true });
    return Object.fromEntries(groups.map(row => [row.state, row._count]));
  }
  /** Query each category before limiting it; queued submissions must never hide execution. */
  async overview(executingIds: readonly string[] = []): Promise<{ counts: Record<string, number>; attention: TaskSummary[]; active: (TaskSummary & { workItems: Record<string, unknown>[] })[]; recent: TaskSummary[] }> {
    const counts = await this.stateCounts();
    const attention = (await this.summaries({ states: ['awaiting_mode', 'awaiting_plan_approval'], limit: 50 })).tasks;
    const executing = (await this.summaries({ states: ['running', 'validating', 'reviewing', 'committing', 'repairing'], limit: 50 })).tasks;
    const queued = (await this.summaries({ states: ['planning', 'ready'], limit: 50 })).tasks;
    const actual = (await Promise.all(executingIds.map(async id => {
      const task = await this.task(id); if (['completed', 'failed', 'cancelled', 'awaiting_mode', 'awaiting_plan_approval'].includes(task.state)) return [];
      const row = (await this.db.prepare('SELECT insertion_order FROM tasks WHERE id=$1').get(id))!;
      return [await this.summarize(task, Number(row.insertion_order))];
    }))).flat();
    const active = (await Promise.all([...new Map([...executing, ...queued, ...actual].map(task => [task.id, task])).values()].sort((a, b) => b.sequence - a.sequence).map(async t => ({ ...t, workItems: await this.workItems(t.id) }))));
    const recent = (await this.summaries({ states: ['completed', 'failed', 'cancelled'], limit: 8 })).tasks;
    return { counts, attention, active, recent };
  }
  /** Approval is historical evidence, not an inference from the task's present state. */
  async planApproval(id: string): Promise<{ status: 'not-planned' | 'autonomous' | 'awaiting' | 'approved' | 'not-approved'; timestamp?: string }> {
    const task = await this.task(id);
    if (!task.plan) return { status: 'not-planned' };
    if (task.mode === 'autonomous') return { status: 'autonomous' };
    const candidates = await this.db.prepare("SELECT data FROM events WHERE task_id=$1 AND data LIKE '%Plan explicitly approved%' ORDER BY sequence DESC").all(id);
    for (const row of candidates) {
      const event = JSON.parse(String(row.data)) as TaskEvent;
      if (event.actor === 'user' && event.state === 'ready' && event.reason === 'Plan explicitly approved') return { status: 'approved', timestamp: event.timestamp };
    }
    return { status: task.state === 'awaiting_plan_approval' ? 'awaiting' : 'not-approved' };
  }
  async hasTask(id: string): Promise<boolean> { return Boolean(await this.db.models.task.findUnique({ where: this.byId(id), select: { id: true } })); }
  async task(id: string): Promise<Task> {
    const row = await this.db.models.task.findUnique({ where: this.byId(id), select: { data: true } });
    if (!row) throw new AppError('not_found', 'Unknown task', 404);
    return this.safeTask(JSON.parse(row.data as string) as Task);
  }
  /**
   * Creates a task atomically with its frozen team configuration. The idempotency check runs first,
   * so retrying an earlier submission returns the original task even after the team or defaults
   * changed; only a new submission resolves defaults and `freeze`, inside the insert transaction.
   * New fingerprints identify submitted input, before defaults. Unprefixed legacy fingerprints
   * included the resolved mode, so omitted-mode retries may match either historical mode. Those
   * rows cannot distinguish explicit from defaulted modes; never infer that from mutable task data.
   */
  /** A task may only name a ticket of a source its project is connected to. */
  private async taskTicket(projectId: string, ref: TicketRef): Promise<TaskTicket> {
    const integrations = (await this.project(projectId)).integrations; const read = ref.readAt ? { readAt: ref.readAt } : {};
    if (ref.source === 'jira') {
      if (!integrations?.jira) throw new AppError('not_connected', 'Jira is not connected for this project', 422);
      const key = ref.key.toUpperCase();
      return { source: 'jira', name: 'Jira', key, url: `${integrations.jira.site}/browse/${encodeURIComponent(key)}`, ...read };
    }
    if (!integrations?.trackers?.some(c => c.trackerId === ref.source)) throw new AppError('not_connected', 'This ticket tool is not connected for this project', 422);
    return { source: ref.source, name: (await this.tracker(ref.source)).name, key: ref.key, ...(ref.url ? { url: ref.url } : {}), ...read };
  }
  async createTask(input: unknown, key: string, freeze?: (task: Task) => TaskTeam | undefined | Promise<TaskTeam | undefined>, defaultMode?: () => Task['mode'] | Promise<Task['mode']>, devagentsRules = true, followUp?: Task['followUp'], sharedOwner?: string): Promise<Task> {
    const parsed = TaskInput.parse(input);
    if ((await this.project(parsed.projectId)).archivedAt) throw new AppError('project_archived', 'This project is archived. Restore it before submitting work.', 409);
    const clean = redactValues(parsed, this.secrets) as typeof parsed;
    const hash = (value: typeof parsed) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const fingerprint = `input-v2:${hash(parsed)}`;
    return this.transaction(async () => {
      const previous = await this.db.models.submissionRequest.findUnique({ where: { workspace_id_key: { workspace_id: this.workspaceId, key } } });
      if (previous) {
        const legacy = typeof previous.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(previous.fingerprint);
        const matchesLegacy = legacy && (previous.fingerprint === hash(parsed) || (parsed.mode === undefined && Mode.options.some(mode => previous.fingerprint === hash(TaskInput.parse({ ...parsed, mode })))));
        if (previous.fingerprint !== fingerprint && !matchesLegacy) throw new AppError('idempotency_conflict', 'Idempotency key was used with different input', 409);
        return this.task(previous.task_id as string);
      }
      const now = new Date().toISOString();
      const mode = clean.mode ?? await defaultMode?.();
      const { ticket: ref, ...rest } = clean; const ticket = ref ? await this.taskTicket(rest.projectId, ref) : undefined;
      let task: Task = { ...rest, ...(ticket ? { ticket } : {}), ...(followUp ? { followUp } : {}), ...(mode ? { mode } : {}), devagentsRules, id: randomUUID(), runId: randomUUID(), state: mode ? 'planning' : 'awaiting_mode', version: 0, createdAt: now, updatedAt: now };
      const team = await freeze?.(task);
      if (team) task = { ...task, team, agents: team.members.map(m => ({ ...m, schemaVersion: 1 as const, instructionsFile: 'team', source: `team:${team.id}@${team.revision}` })) };
      await this.db.models.task.create({ data: { workspace_id: this.workspaceId, id: task.id, project_id: task.projectId, state: task.state, version: task.version, data: this.taskJson(task) } });
      await this.db.models.submissionRequest.create({ data: { workspace_id: this.workspaceId, key, fingerprint, task_id: task.id } });
      if (sharedOwner) {
        if (await this.workspaceOwnerId() !== sharedOwner) throw new AppError('workspace_owner_mismatch', 'Shared submission requires its workspace owner', 403);
        await this.db.prepare("INSERT INTO shared_task_handoffs VALUES ($1, $2, $3, 'held', $4)").run(task.id, sharedOwner, randomUUID(), this.taskJson(task));
      }
      await this.requestDispatchRow(task);
      await this.append(task, 'user', `${mode ? 'Task submitted with autonomy mode' : 'Choose autonomous or plan-approval to continue'}${team ? ` · team "${team.name}" revision ${team.revision} frozen` : ''}${ticket ? ` · started from ${ticket.name} ticket ${ticket.key}` : ''}`);
      return task;
    });
  }
  async transition(id: string, expectedVersion: number, state: TaskState, actor: string, reason: string, patch: Partial<Pick<Task, 'mode' | 'plan' | 'workspace' | 'agents' | 'outcome'>> = {}): Promise<Task> {
    return this.transaction(async () => {
      await this.assertWriter(id);
      const task = await this.task(id);
      if (task.version !== expectedVersion) throw new AppError('stale_task', 'Task changed; reload before retrying', 409);
      assertTransition(task.state, state);
      const updated: Task = { ...task, ...patch, state, version: task.version + 1, updatedAt: new Date().toISOString() };
      await this.db.models.task.update({ where: this.byId(id), data: { state, version: updated.version, data: this.taskJson(updated) } });
      if (actor === 'user' && ['planning', 'ready', 'cancelled'].includes(state)) await this.requestDispatchRow(updated);
      await this.append(updated, actor, reason);
      return this.task(id);
    });
  }
  async checkpoint(id: string, expectedVersion: number, patch: Partial<Pick<Task, 'workspace' | 'agents' | 'outcome'>>, reason: string): Promise<Task> {
    return this.transaction(async () => {
      await this.assertWriter(id);
      const task = await this.task(id);
      if (task.version !== expectedVersion) throw new AppError('stale_task', 'Task changed; reload before retrying', 409);
      const updated = { ...task, ...patch, version: task.version + 1, updatedAt: new Date().toISOString() };
      await this.db.models.task.update({ where: this.byId(id), data: { version: updated.version, data: this.taskJson(updated) } });
      await this.append(updated, 'orchestrator', reason);
      return this.task(id);
    });
  }
  async record(id: string, kind: string, data: unknown): Promise<void> {
    await this.transaction(async () => {
      await this.assertWriter(id); await this.task(id);
      await this.db.models.evidence.create({ data: { workspace_id: this.workspaceId, task_id: id, kind, data: this.json({ at: new Date().toISOString(), data }) } });
    });
  }
  async evidence(id: string, after = 0, limit = 100000): Promise<{ sequence: number; kind: string; at: string; data: unknown }[]> {
    await this.task(id);
    return (await this.db.prepare('SELECT sequence,kind,data FROM evidence WHERE task_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3').all(id, after, limit)).map(r => ({ sequence: Number(r.sequence), kind: String(r.kind), ...JSON.parse(String(r.data)) }));
  }
  /** Evidence of the given kinds in order, without loading the rest of the task's record. */
  async evidenceOf(id: string, kinds: string[]): Promise<{ sequence: number; kind: string; at: string; data: unknown }[]> {
    return (await this.db.prepare(`SELECT sequence,kind,data FROM evidence WHERE task_id=$1 AND kind=ANY($2::text[]) ORDER BY sequence`).all(id, kinds)).map(r => ({ sequence: Number(r.sequence), kind: String(r.kind), ...JSON.parse(String(r.data)) }));
  }
  /** The newest evidence of one kind, without loading the task's whole record. */
  async lastEvidence(id: string, kind: string): Promise<{ sequence: number; at: string; data: unknown } | undefined> {
    const row = await this.db.prepare('SELECT sequence,data FROM evidence WHERE task_id=$1 AND kind=$2 ORDER BY sequence DESC LIMIT 1').get(id, kind);
    return row ? { sequence: Number(row.sequence), ...JSON.parse(String(row.data)) } : undefined;
  }
  /** Completed tasks that carry evidence of `kind` and none of `settled`: work that is still owed after completion. */
  async completedAwaiting(kind: string, settled: string[]): Promise<string[]> {
    return (await this.db.prepare(`SELECT e.task_id FROM evidence e JOIN tasks t ON t.id=e.task_id WHERE e.kind=$1 AND t.state='completed' AND NOT EXISTS (SELECT 1 FROM evidence x WHERE x.task_id=e.task_id AND x.kind=ANY($2::text[])) GROUP BY e.task_id ORDER BY min(e.sequence)`).all(kind, settled)).map(r => String(r.task_id));
  }
  /** Read every execution boundary without loading paginated tool logs or large agent outputs. */
  async executionEvidence(id: string): Promise<import('../domain/execution.js').ExecutionEvent[]> {
    await this.task(id);
    return projectEvidence(this.db, id, 'execution');
  }
  /** Select only usage facts; large model output and command logs never enter the rollup. */
  async usageEvidence(id: string): Promise<import('../domain/usage-types.js').UsageEvent[]> {
    await this.task(id);
    return projectEvidence(this.db, id, 'usage');
  }
  async evidenceEntry(id: string, sequence: number): Promise<{ sequence: number; kind: string; at: string; data: unknown }> {
    await this.task(id);
    const row = await this.db.prepare('SELECT sequence,kind,data FROM evidence WHERE task_id=$1 AND sequence=$2').get(id, sequence);
    if (!row) throw new AppError('not_found', 'Unknown evidence entry', 404);
    return { sequence: Number(row.sequence), kind: String(row.kind), ...JSON.parse(String(row.data)) };
  }
  async workItems(id: string): Promise<Record<string, unknown>[]> {
    const task = await this.task(id);
    const items = new Map<string, Record<string, unknown>>((task.plan?.items ?? []).map(i => [i.id, { itemId: i.id, state: 'pending', agentId: i.assignedAgent, branch: i.branch, dependsOn: i.dependsOn, ownedPaths: i.ownedPaths }]));
    let recorded = false;
    const evidence = await this.evidence(id);
    for (const event of evidence) {
      if (event.kind !== 'work-item') continue;
      recorded = true;
      const data = event.data as Record<string, unknown>;
      if (typeof data.itemId === 'string' && items.has(data.itemId)) items.set(data.itemId, { ...items.get(data.itemId), ...data, updatedAt: event.at });
    }
    if (!recorded && task.plan?.items.length === 1) for (const item of items.values()) item.state = task.state;
    if (['failed', 'cancelled'].includes(task.state)) for (const item of items.values()) {
      if (!['completed', 'failed', 'cancelled', 'blocked', 'aborted', 'interrupted'].includes(String(item.state))) item.state = task.state === 'cancelled' ? 'cancelled' : item.state === 'pending' ? 'blocked' : 'interrupted';
    }
    // A QA environment blocker is not a failed implementation. Preserve historical task
    // outcomes, but derive the single item's own result from its recorded handoff.
    if (!recorded && task.plan?.items.length === 1 && task.state === 'failed' && task.outcome?.error?.startsWith('QA could not verify required acceptance criteria.')) {
      const implementation = evidence.findLastIndex(e => e.kind === 'run-started' && (e.data as { phase?: string }).phase === 'implementation');
      const qa = evidence.findLastIndex(e => e.kind === 'qa-result' && (e.data as { state?: string }).state === 'blocked');
      if (implementation >= 0 && qa > implementation && evidence.slice(implementation, qa).some(e => e.kind === 'run-completed' && (e.data as { phase?: string }).phase === 'implementation')) {
        for (const item of items.values()) item.state = 'implemented';
      }
    }
    return [...items.values()];
  }
  private async append(task: Task, actor: string, reason: string): Promise<void> {
    await this.db.models.taskEvent.create({ data: { workspace_id: this.workspaceId, task_id: task.id,
      data: this.json({ taskId: task.id, runId: task.runId, actor, reason, state: task.state, timestamp: task.updatedAt }) } });
  }
  async events(id: string, after = 0, limit = 100000): Promise<TaskEvent[]> {
    await this.task(id);
    const rows = await this.db.models.taskEvent.findMany({ where: { task_id: id, sequence: { gt: after } },
      orderBy: { sequence: 'asc' }, take: limit, select: { sequence: true, data: true } });
    return rows.map(row => ({ ...JSON.parse(row.data), sequence: Number(row.sequence) }) as TaskEvent);
  }
  async recover(): Promise<string[]> {
    // Never replay a worker or external effect after restart. Approval waits survive intact.
    const interrupted: Task[] = [];
    for (const t of await this.tasks()) {
      if (['running', 'validating', 'reviewing', 'committing', 'repairing'].includes(t.state)
      || (t.state === 'planning' && (t.workspace || (await this.evidence(t.id)).some(e => e.kind === 'worktree-intent')))
      || (t.state === 'ready' && (await this.evidence(t.id)).some(e => ['environment', 'run-started', 'run-failed'].includes(e.kind)
        && (e.kind === 'environment' || (e.data as { phase?: string }).phase !== 'planning')))) interrupted.push(t);
    }
    for (const task of interrupted) {
      const reason = 'Process interrupted; inspect task evidence and any recovery snapshot before submitting a new task';
      await this.transition(task.id, task.version, 'failed', 'recovery', reason, { outcome: { ...task.outcome, error: reason, repairCycles: task.outcome?.repairCycles ?? 0 } });
      await this.recoverDispatch(task.id, 'Execution was interrupted; prior worker termination is unverified. Inspect retained work before cleanup or resubmission.');
    }
    return interrupted.map(t => t.id);
  }
}
