import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { Store } from '../persistence/store.js';
import { Mode, TaskInput, TeamInput, type AgentDefinition, type AppConfig, type Task, type TaskTeam, type TeamMember, type TeamRecord, type TeamReadiness, type TeamSummary } from '../domain/schemas.js';
import { terminalStates } from '../domain/lifecycle.js';
import { AppError } from '../domain/errors.js';
import { inspectProject, WorkspaceManager } from '../workspace/git.js';
import { builtinCapabilities, builtinDirectory, loadRegistry } from '../agents/registry.js';
import { providerExecutable, resolveEngine, resolveProviderId, teamReadiness, type RuntimeSupport } from '../domain/readiness.js';
import { validatePlan } from '../domain/plan.js';
import { isWithin } from '../workspace/paths.js';

export class TaskService {
  private runner?: { enqueue(id: string): void; cancel(id: string): void };
  /** `executableEngines` is what this build can actually run; the schema accepts more engines than that. */
  constructor(readonly store: Store, readonly config: AppConfig, readonly dataDir: string, readonly platform: NodeJS.Platform = process.platform, readonly executableEngines: ReadonlySet<string> = new Set(['codex'])) {}
  get support(): RuntimeSupport { return { config: this.config, capabilities: builtinCapabilities, executableEngines: this.executableEngines, platform: this.platform }; }
  attachRunner(runner: { enqueue(id: string): void; cancel(id: string): void }): void { this.runner = runner; }
  get executionEnabled(): boolean { return Boolean(this.runner); }
  run(id: string): Task {
    if (!this.runner) throw new AppError('execution_unavailable', 'No execution runtime attached', 503);
    this.runner.enqueue(id); return this.store.task(id);
  }
  async registerProject(input: unknown) { return this.store.registerProject(await inspectProject(input)); }
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
      defaults: { engine: this.config.defaultEngine, provider: this.config.defaultProvider, model: this.config.defaultModel ?? null },
      capabilities: [...builtinCapabilities].sort(),
      engines: ['codex', 'claude-code'].map(id => ({ id, executable: executable(id), reason: executable(id) ? null : 'not available until M4 (no adapter in this build)' })),
      providers: this.config.providers.map(p => ({ id: p.id, kind: p.kind, auth: p.auth, executable: providerExecutable(p), reason: providerExecutable(p) ? null : 'configuration only; execution needs the official OpenAI provider' })),
      limits: { members: 12, instructions: 16000, capabilities: 20 },
    };
  }
  /** Server-side diagnostics for an unsaved draft; the browser never computes readiness itself. */
  checkTeam(input: unknown): { readiness: TeamReadiness } { return { readiness: teamReadiness(TeamInput.parse(input).members, this.support) }; }
  createTeam(input: unknown) { const team = TeamInput.parse(input); teamReadiness(team.members, this.support); return this.withReadiness(this.store.createTeam(team)); }
  updateTeam(id: string, expectedRevision: number, input: unknown) { const team = TeamInput.parse(input); teamReadiness(team.members, this.support); return this.withReadiness(this.store.updateTeam(id, expectedRevision, team)); }
  setTeamArchived(id: string, expectedRevision: number, archived: boolean) { return this.withReadiness(this.store.setTeamArchived(id, expectedRevision, archived)); }
  duplicateTeam(id: string, name: unknown) { return this.withReadiness(this.store.duplicateTeam(id, TeamInput.shape.name.parse(name))); }
  setProjectDefaultTeam(projectId: string, teamId: string | null, expectedVersion: number) { return this.store.setProjectDefaultTeam(projectId, teamId, expectedVersion); }
  /** Registry agents offered as member templates: explicit copies, never links back to the YAML. */
  async templates(projectId?: string): Promise<TeamMember[]> {
    return (await this.agents(projectId)).map(a => ({ id: a.id, name: a.name, description: a.description, enabled: a.enabled, engine: a.engine, provider: a.provider, model: a.model, capabilities: [...a.capabilities], instructions: a.instructions.slice(0, 16000), delegation: { ...a.delegation }, permissions: { readPaths: [...a.permissions.readPaths], writePaths: [...a.permissions.writePaths], allowCommands: a.permissions.allowCommands, allowPush: false as const }, concurrency: a.concurrency, origin: 'template' as const, templateId: a.id }));
  }
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
  submit(input: unknown, key: string): Task {
    const task = TaskInput.parse(input);
    const mode = task.mode ?? this.store.project(task.projectId).defaultMode ?? this.config.defaultMode;
    const created = this.store.createTask({ ...task, ...(mode ? { mode } : {}) }, key, () => this.freezeTeam(task.teamId, task.projectId));
    this.runner?.enqueue(created.id); return created;
  }
  mode(id: string, mode: unknown): Task {
    const parsed = Mode.parse(mode); const task = this.store.task(id);
    if (task.state !== 'awaiting_mode') throw new AppError('invalid_transition', 'Autonomy mode has already been selected', 409);
    const updated = this.store.transition(id, task.version, 'planning', 'user', `Autonomy selected: ${parsed}`, { mode: parsed });
    this.runner?.enqueue(id); return updated;
  }
  async proposePlan(id: string, input: unknown, snapshot?: AgentDefinition[]): Promise<Task> {
    if (this.runner && !snapshot) throw new AppError('automatic_planning', 'The active execution service generates plans automatically', 409);
    const task = this.store.task(id);
    if (task.state !== 'planning') throw new AppError('invalid_transition', 'Task is not awaiting a plan', 409);
    const plan = validatePlan(input, task.projectId, snapshot ?? task.agents ?? await this.agents(task.projectId), { platform: this.platform });
    if (task.workspace && plan.items.some(item => item.branch !== (plan.items.length === 1 ? task.workspace!.branch : `${task.workspace!.branch}-${item.id}`))) throw new AppError('branch_mismatch', 'Plan branches must match their managed task/work-item branches');
    return this.store.transition(id, task.version, task.mode === 'plan-approval' ? 'awaiting_plan_approval' : 'ready', 'planner', 'Validated plan stored', { plan });
  }
  approve(id: string, version: number): Task {
    const task = this.store.task(id);
    if (task.state !== 'awaiting_plan_approval') throw new AppError('invalid_transition', 'Task is not awaiting plan approval', 409);
    const updated = this.store.transition(id, version, 'ready', 'user', 'Plan explicitly approved');
    this.runner?.enqueue(id); return updated;
  }
  /** Explicit, user-invoked removal of a finished task's managed worktrees and item branches. Never automatic. */
  async cleanup(id: string): Promise<{ removedWorktrees: string[]; removedBranches: string[]; keptBranches: string[] }> {
    const task = this.store.task(id);
    if (!terminalStates.includes(task.state)) throw new AppError('task_active', 'Cleanup requires a completed, failed or cancelled task', 409);
    const seen = new Set<string>(); const workspaces: { path: string; branch: string }[] = [];
    const add = (w: unknown) => {
      const workspace = w as { path?: unknown; branch?: unknown } | undefined;
      if (typeof workspace?.path !== 'string' || typeof workspace?.branch !== 'string' || seen.has(workspace.path)) return;
      seen.add(workspace.path); workspaces.push({ path: workspace.path, branch: workspace.branch });
    };
    add(task.workspace);
    for (const event of this.store.evidence(id)) if (event.kind === 'work-item') add((event.data as { workspace?: unknown }).workspace);
    // A completed task's branch is the deliverable; failed or cancelled tasks leave nothing worth keeping.
    const keep = new Set(task.state === 'completed' && task.workspace ? [task.workspace.branch] : []);
    const result = await new WorkspaceManager(this.dataDir).cleanup(this.store.project(task.projectId), id, workspaces, keep);
    this.store.record(id, 'cleanup', result);
    return result;
  }
  cancel(id: string): Task {
    const task = this.store.task(id);
    if (task.state === 'cancelled') return task;
    if (task.state === 'committing') throw new AppError('commit_in_progress', 'Local commit is being finalized; inspect the resulting task before further action', 409);
    if (terminalStates.includes(task.state)) throw new AppError('invalid_transition', 'Task already finished', 409);
    this.runner?.cancel(id);
    return this.store.transition(id, task.version, 'cancelled', 'user', 'Task cancelled or plan rejected');
  }
}
