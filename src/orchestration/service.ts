import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { Store } from '../persistence/store.js';
import { Mode, TaskInput, type AgentDefinition, type AppConfig, type Task } from '../domain/schemas.js';
import { terminalStates } from '../domain/lifecycle.js';
import { AppError } from '../domain/errors.js';
import { inspectProject } from '../workspace/git.js';
import { builtinDirectory, loadRegistry } from '../agents/registry.js';
import { validatePlan } from '../domain/plan.js';
import { isWithin } from '../workspace/paths.js';

export class TaskService {
  private runner?: { enqueue(id: string): void; cancel(id: string): void };
  constructor(readonly store: Store, readonly config: AppConfig, readonly dataDir: string, readonly platform: NodeJS.Platform = process.platform) {}
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
  submit(input: unknown, key: string): Task {
    const task = TaskInput.parse(input);
    const mode = task.mode ?? this.store.project(task.projectId).defaultMode ?? this.config.defaultMode;
    const created = this.store.createTask({ ...task, ...(mode ? { mode } : {}) }, key);
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
  cancel(id: string): Task {
    const task = this.store.task(id);
    if (task.state === 'cancelled') return task;
    if (task.state === 'committing') throw new AppError('commit_in_progress', 'Local commit is being finalized; inspect the resulting task before further action', 409);
    if (terminalStates.includes(task.state)) throw new AppError('invalid_transition', 'Task already finished', 409);
    this.runner?.cancel(id);
    return this.store.transition(id, task.version, 'cancelled', 'user', 'Task cancelled or plan rejected');
  }
}
