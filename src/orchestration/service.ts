import { readTaskDiff } from '../workspace/diff.js';
import { z } from 'zod';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { Store } from '../persistence/store.js';
import { Mode, TaskInput, TeamInput, TEAM_INSTRUCTION_BYTES, type AgentDefinition, type AppConfig, type Task, type TaskTeam, type TeamMember, type TeamRecord, type TeamReadiness, type TeamSummary } from '../domain/schemas.js';
import { terminalStates } from '../domain/lifecycle.js';
import { AppError } from '../domain/errors.js';
import { redactReportProse } from '../domain/limitations.js';
import { inspectProject, WorkspaceManager } from '../workspace/git.js';
import { builtinCapabilities, builtinDirectory, loadRegistry } from '../agents/registry.js';
import { providerExecutable, resolveEngine, resolveProviderId, teamReadiness, type RuntimeSupport } from '../domain/readiness.js';
import { validatePlan } from '../domain/plan.js';
import { taskRules } from '../domain/execution-policy.js';
import { isWithin } from '../workspace/paths.js';
import { availableDiskBytes, DATABASE_HEADROOM } from '../workspace/disk-space.js';
import { WorktreeCompactor } from '../workspace/compaction.js';
import { STARTER_TEAM_ID, STARTER_TEAM_NAME, STARTER_ROLES } from '../domain/starter-team.js';
import { log, redact } from '../telemetry/redact.js';

type Runner = { enqueue(id: string): void; cancel(id: string): void; isDrained?(id: string): boolean; readonly executionFailure?: { taskId: string; message: string } | undefined };
export class TaskService {
  private runner?: Runner;
  private readonly maintaining = new Set<string>();
  private compactor: WorktreeCompactor | undefined;
  /** `executableEngines` is what this build can actually run; the schema accepts more engines than that. */
  constructor(readonly store: Store, readonly config: AppConfig, readonly dataDir: string, readonly platform: NodeJS.Platform = process.platform, readonly executableEngines: ReadonlySet<string> = new Set(['codex'])) {}
  get support(): RuntimeSupport { return { config: this.config, capabilities: builtinCapabilities, executableEngines: this.executableEngines, platform: this.platform }; }
  attachRunner(runner: Runner): void { this.runner = runner; }
  get executionEnabled(): boolean { return Boolean(this.runner); }
  get executionFailure() { return this.runner?.executionFailure; }
  private assertExecutionAvailable(): void {
    if (this.executionFailure) throw new AppError('execution_halted', 'Execution halted; recover storage and restart the service before submitting more work', 503);
  }
  async storageStatus() {
    const availableBytes = await availableDiskBytes(this.dataDir).catch(() => undefined);
    return { measured: availableBytes !== undefined, ...(availableBytes !== undefined ? { availableBytes } : {}),
      minimumStartBytes: this.config.minFreeDiskBytes, databaseHeadroomBytes: DATABASE_HEADROOM,
      compactCompletedTasks: this.config.compactCompletedTasks,
      ...(this.executionFailure ? { executionFailure: this.executionFailure } : {}) };
  }
  assertNotMaintaining(id: string): void {
    if (this.maintaining.has(id)) throw new AppError('task_maintenance', 'Task storage maintenance is in progress; try again afterwards', 409);
  }
  private async maintenance<T>(id: string, action: (task: Task) => Promise<T>): Promise<T> {
    this.assertNotMaintaining(id);
    const task = this.store.task(id);
    if (!terminalStates.includes(task.state)) throw new AppError('task_active', 'Storage maintenance requires a completed, failed or cancelled task', 409);
    if (this.runner && !this.runner.isDrained?.(id)) throw new AppError('task_active', 'Task workers are still draining; try again after they stop', 409);
    // Synchronous acquisition with no await between state/ownership checks and the lease.
    // Run/approve/cancel share this guard; never wait for drain while holding it.
    this.maintaining.add(id);
    try { return await action(task); } finally { this.maintaining.delete(id); }
  }
  private taskWorkspaces(task: Task): { path: string; branch: string }[] {
    const workspaces = new Map<string, { path: string; branch: string }>();
    const add = (value: unknown) => {
      const w = value as { path?: unknown; branch?: unknown } | undefined;
      if (w != null && (typeof w.path !== 'string' || typeof w.branch !== 'string')) throw new AppError('compaction_ownership', 'Malformed worktree ownership record', 409);
      if (typeof w?.path === 'string' && typeof w.branch === 'string') {
        const previous = workspaces.get(w.path);
        if (previous && previous.branch !== w.branch) throw new AppError('compaction_ownership', 'Conflicting worktree ownership records', 409);
        workspaces.set(w.path, { path: w.path, branch: w.branch });
      }
    };
    add(task.workspace);
    for (const e of this.store.evidence(task.id)) if (e.kind === 'work-item') add((e.data as { workspace?: unknown }).workspace);
    return [...workspaces.values()];
  }
  private taskRunIds(id: string): string[] {
    return this.store.evidence(id).filter(e => e.kind === 'run-started').map(e => {
      const runId = (e.data as { runId?: unknown }).runId;
      if (typeof runId !== 'string') throw new AppError('compaction_ownership', 'Malformed execution run ownership record', 409);
      return runId;
    });
  }
  compactionPreview(id: string) {
    return this.maintenance(id, task => (this.compactor ??= new WorktreeCompactor(this.dataDir)).preview(this.store.project(task.projectId), id, this.taskWorkspaces(task), this.taskRunIds(id)));
  }
  compact(id: string, digest: string) {
    return this.maintenance(id, task => (this.compactor ??= new WorktreeCompactor(this.dataDir)).compact(this.store.project(task.projectId), id, this.taskWorkspaces(task), digest,
      preview => this.store.record(id, 'compaction-intent', preview),
      result => this.store.record(id, 'compaction', { digest, ...result }), this.taskRunIds(id)));
  }
  /** Reclaim generated resources, then clean checkouts; never use forceful cleanup or delete result branches. */
  async compactCompletedTask(id: string): Promise<void> {
    if (!this.config.compactCompletedTasks || this.store.task(id).state !== 'completed') return;
    try {
      await this.maintenance(id, async task => {
        const compactor = this.compactor ??= new WorktreeCompactor(this.dataDir);
        const project = this.store.project(task.projectId); const workspaces = this.taskWorkspaces(task);
        const runIds = this.taskRunIds(id);
        const preview = await compactor.preview(project, id, workspaces, runIds);
        if (preview.candidates.length) await compactor.compact(project, id, workspaces, preview.digest,
          intent => this.store.record(id, 'compaction-intent', { ...intent, automatic: true }),
          result => this.store.record(id, 'compaction', { digest: preview.digest, automatic: true, ...result }), runIds);
        if (task.workspace && task.outcome?.commit) await new WorkspaceManager(this.dataDir).removeCleanCompleted(project, id, workspaces,
          { branch: task.workspace.branch, commit: task.outcome.commit },
          workspace => this.store.record(id, 'worktree-cleanup-intent', { automatic: true, ...workspace }),
          workspace => this.store.record(id, 'worktree-cleanup', { automatic: true, ...workspace }));
      });
    } catch (error) {
      // Maintenance cannot turn a reviewed result into a failed task or hide storage trouble.
      const message = String(redact(error instanceof Error ? error.message : String(error), this.store.secrets)).slice(0, 2000);
      try { this.store.record(id, 'compaction-deferred', { automatic: true, message }); } catch { /* log without the database */ }
      log('compaction_deferred', { taskId: id, message });
    }
  }
  run(id: string): Task {
    this.assertExecutionAvailable();
    this.assertNotMaintaining(id);
    if (!this.runner) throw new AppError('execution_unavailable', 'No execution runtime attached', 503);
    this.runner.enqueue(id); return this.store.task(id);
  }
  async registerProject(input: unknown) {
    const project = await inspectProject(input);
    const starter = this.store.teams('all').find(t => t.id === STARTER_TEAM_ID);
    return this.store.registerProject(project, starter && !starter.archived && teamReadiness(starter.members, this.support).ready ? starter.id : undefined);
  }
  /** Called before serving requests. Seed only bundled roles, never project/user registry overrides. */
  async initializeStarterTeam() {
    const bundled = await loadRegistry([builtinDirectory], this.config);
    const members = STARTER_ROLES.map(id => {
      const agent = bundled.find(a => a.id === id);
      if (!agent) throw new AppError('starter_unavailable', `Missing bundled starter role: ${id}`);
      return this.memberTemplate(agent);
    });
    const team = this.store.ensureStarterTeam({ name: STARTER_TEAM_NAME, description: 'Plans changes, develops independent frontend and backend work in parallel, and independently reviews the combined result.', members }, t => !t.archived && teamReadiness(t.members, this.support).ready);
    return this.withReadiness(team);
  }
  async agents(projectId?: string) {
    const directories = [builtinDirectory, join(this.dataDir, 'agents')];
    if (projectId) {
      const project = this.store.project(projectId);
      const overrides = join(project.path, '.devagents', 'agents');
      try {
        if (!isWithin(project.path, await realpath(overrides))) throw new AppError('path_denied', 'Agent override directory escapes project');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      directories.push(overrides);
    }
    return loadRegistry(directories, this.config);
  }
  // Saved teams. Validity (throws) and readiness (diagnostics) are separate: a draft can be saved, not run.
  private withReadiness(team: TeamRecord): TeamRecord & { readiness: TeamReadiness } { return { ...team, readiness: teamReadiness(team.members, this.support) }; }
  teams(filter: 'active' | 'archived' | 'all' = 'active'): TeamSummary[] {
    return this.store.teams(filter).map(t => ({ id: t.id, name: t.name, description: t.description, revision: t.revision, archived: t.archived, createdAt: t.createdAt, updatedAt: t.updatedAt, members: t.members.length, enabledMembers: t.members.filter(m => m.enabled).length, readiness: teamReadiness(t.members, this.support) }));
  }
  team(id: string) { return { ...this.withReadiness(this.store.team(id)), revisions: this.store.teamRevisions(id) }; }
  /** What the member editor may offer, with the reason for everything it must disable. */
  teamOptions() {
    const executable = (id: string) => this.executableEngines.has(id);
    return {
      platform: this.platform,
      defaults: { devagentsRules: this.config.devagentsRules, engine: this.config.defaultEngine, provider: this.config.defaultProvider, model: this.config.defaultModel ?? null },
      capabilities: [...builtinCapabilities].sort(),
      engines: ['codex', 'claude-code'].map(id => ({ id, executable: executable(id), reason: executable(id) ? null : 'not available until M4 (no adapter in this build)' })),
      providers: this.config.providers.map(p => ({ id: p.id, kind: p.kind, auth: p.auth, executable: providerExecutable(p), reason: providerExecutable(p) ? null : 'configuration only; execution needs the official OpenAI provider' })),
      limits: { members: 12, instructions: 64000, instructionBytes: TEAM_INSTRUCTION_BYTES, capabilities: 20 },
    };
  }
  /** Server-side diagnostics for an unsaved draft; the browser never computes readiness itself. */
  checkTeam(input: unknown): { readiness: TeamReadiness } { return { readiness: teamReadiness(TeamInput.parse(input).members, this.support) }; }
  createTeam(input: unknown) { const team = TeamInput.parse(input); teamReadiness(team.members, this.support); return this.withReadiness(this.store.createTeam(team)); }
  updateTeam(id: string, expectedRevision: number, input: unknown) { const team = TeamInput.parse(input); teamReadiness(team.members, this.support); return this.withReadiness(this.store.updateTeam(id, expectedRevision, team)); }
  setTeamArchived(id: string, expectedRevision: number, archived: boolean) { return this.withReadiness(this.store.setTeamArchived(id, expectedRevision, archived)); }
  duplicateTeam(id: string, name: unknown) { return this.withReadiness(this.store.duplicateTeam(id, z.string().min(1).max(100).parse(name))); }
  setProjectDefaultTeam(projectId: string, teamId: string | null, expectedVersion: number) { return this.store.setProjectDefaultTeam(projectId, teamId, expectedVersion); }
  /** Registry agents offered as member templates: complete explicit copies, never links back to the YAML and never truncated. */
  async templates(projectId?: string): Promise<TeamMember[]> {
    return (await this.agents(projectId)).map(a => this.memberTemplate(a));
  }
  private memberTemplate(a: AgentDefinition): TeamMember { return { id: a.id, name: a.name, description: a.description, enabled: a.enabled, engine: a.engine, provider: a.provider, model: a.model, capabilities: [...a.capabilities], instructions: a.instructions, delegation: { ...a.delegation }, permissions: { readPaths: [...a.permissions.readPaths], writePaths: [...a.permissions.writePaths], allowCommands: a.permissions.allowCommands, allowPush: false }, concurrency: a.concurrency, origin: 'template', templateId: a.id }; }
  /**
   * Resolves the team for a new task: explicit team, then project default, then the legacy registry
   * (no snapshot here; the runner snapshots legacy agents at worktree creation). Runs inside the
   * task-creation transaction, after the idempotency check, so a retry never re-resolves anything.
   * Engine, provider and model are made concrete now; `model: default` without a configured
   * `defaultModel` stays unpinned and is recorded as such (`modelPinned: false`) rather than guessed.
   */
  private freezeTeam(explicitTeamId: string | undefined, projectId: string): TaskTeam | undefined {
    const project = this.store.project(projectId);
    const teamId = explicitTeamId ?? project.defaultTeamId;
    if (!teamId) return undefined;
    const team = this.store.team(teamId);
    if (team.archived) throw new AppError('team_archived', explicitTeamId ? `Team "${team.name}" is archived; restore it or choose another team` : `The default team "${team.name}" of project ${projectId} is archived; choose a team explicitly or change the project default`, 409);
    const readiness = teamReadiness(team.members, this.support);
    if (!readiness.ready) throw new AppError('team_not_ready', `Team "${team.name}" is a draft and cannot receive work: ${readiness.diagnostics.filter(d => d.level === 'error').map(d => d.message).join('; ')}`, 409);
    const members = team.members.map(m => ({ ...m, engine: resolveEngine(m, this.config), provider: resolveProviderId(m, this.config), model: m.model === 'default' && this.config.defaultModel ? this.config.defaultModel : m.model }));
    const used = new Set(members.map(m => m.provider));
    const providers = this.config.providers.filter(p => used.has(p.id)).map(p => ({ id: p.id, kind: p.kind, auth: p.auth, ...(p.apiKeyEnv ? { apiKeyEnv: p.apiKeyEnv } : {}), ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}) }));
    return { id: team.id, revision: team.revision, name: team.name, snapshotAt: new Date().toISOString(), members, providers, ...(this.config.defaultModel ? { defaultModel: this.config.defaultModel } : {}), modelPinned: members.filter(m => m.enabled).every(m => m.model !== 'default') };
  }
  /** Diff text is redacted with the same secret list the store applies at rest, not only the environment heuristic. */
  diff(id: string) { const task = this.store.task(id); return readTaskDiff(this.store.project(task.projectId), task, this.dataDir, this.store.secrets); }
  submissionOptions() {
    return { projects: this.store.projects().map(p => ({ projectId: p.id, mode: p.defaultMode ?? this.config.defaultMode ?? null, source: p.defaultMode ? 'project' : this.config.defaultMode ? 'service' : 'none' })) };
  }
  submit(input: unknown, key: string): Task {
    this.assertExecutionAvailable();
    const task = TaskInput.parse(input);
    const created = this.store.createTask(task, key, () => this.freezeTeam(task.teamId, task.projectId), () => this.store.project(task.projectId).defaultMode ?? this.config.defaultMode, this.config.devagentsRules);
    this.runner?.enqueue(created.id); return created;
  }
  mode(id: string, mode: unknown): Task {
    this.assertExecutionAvailable();
    this.assertNotMaintaining(id);
    const parsed = Mode.parse(mode); const task = this.store.task(id);
    if (task.state !== 'awaiting_mode') throw new AppError('invalid_transition', 'Autonomy mode has already been selected', 409);
    const updated = this.store.transition(id, task.version, 'planning', 'user', `Autonomy selected: ${parsed}`, { mode: parsed });
    this.runner?.enqueue(id); return updated;
  }
  async proposePlan(id: string, input: unknown, snapshot?: AgentDefinition[]): Promise<Task> {
    if (this.runner && !snapshot) throw new AppError('automatic_planning', 'The active execution service generates plans automatically', 409);
    const task = this.store.task(id);
    if (task.state !== 'planning') throw new AppError('invalid_transition', 'Task is not awaiting a plan', 409);
    const plan = redactReportProse(validatePlan(input, task.projectId, snapshot ?? task.agents ?? await this.agents(task.projectId), { platform: this.platform, devagentsRules: taskRules(task) }), this.store.secrets);
    if (task.workspace && plan.items.some(item => item.branch !== (plan.items.length === 1 ? task.workspace!.branch : `${task.workspace!.branch}-${item.id}`))) throw new AppError('branch_mismatch', 'Plan branches must match their managed task/work-item branches');
    return this.store.transition(id, task.version, task.mode === 'plan-approval' ? 'awaiting_plan_approval' : 'ready', 'planner', 'Validated plan stored', { plan });
  }
  approve(id: string, version: number): Task {
    this.assertExecutionAvailable();
    this.assertNotMaintaining(id);
    const task = this.store.task(id);
    if (task.state !== 'awaiting_plan_approval') throw new AppError('invalid_transition', 'Task is not awaiting plan approval', 409);
    const updated = this.store.transition(id, version, 'ready', 'user', 'Plan explicitly approved');
    this.runner?.enqueue(id); return updated;
  }
  /** Explicit, user-invoked removal of a finished task's managed worktrees and item branches. Never automatic. */
  async cleanup(id: string): Promise<{ removedWorktrees: string[]; removedBranches: string[]; keptBranches: string[] }> {
    return this.maintenance(id, async task => {
      const seen = new Set<string>(); const workspaces: { path: string; branch: string }[] = [];
      const add = (w: unknown) => {
        const workspace = w as { path?: unknown; branch?: unknown } | undefined;
        if (typeof workspace?.path !== 'string' || typeof workspace?.branch !== 'string' || seen.has(workspace.path)) return;
        seen.add(workspace.path); workspaces.push({ path: workspace.path, branch: workspace.branch });
      };
      add(task.workspace);
      for (const event of this.store.evidence(id)) if (event.kind === 'work-item') add((event.data as { workspace?: unknown }).workspace);
      // Legacy explicit removal may discard unfinished work. Use compaction to preserve it.
      const keep = new Set(task.state === 'completed' && task.workspace ? [task.workspace.branch] : []);
      const result = await new WorkspaceManager(this.dataDir).cleanup(this.store.project(task.projectId), id, workspaces, keep);
      this.store.record(id, 'cleanup', result);
      return result;
    });
  }
  cancel(id: string): Task {
    this.assertNotMaintaining(id);
    const task = this.store.task(id);
    if (task.state === 'cancelled') return task;
    if (task.state === 'committing') throw new AppError('commit_in_progress', 'Local commit is being finalized; inspect the resulting task before further action', 409);
    if (terminalStates.includes(task.state)) throw new AppError('invalid_transition', 'Task already finished', 409);
    this.runner?.cancel(id);
    return this.store.transition(id, task.version, 'cancelled', 'user', 'Task cancelled or plan rejected');
  }
}
