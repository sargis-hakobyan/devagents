import { randomUUID } from 'node:crypto';
import type { DispatchClaim } from '../domain/dispatch.js';
import type { CodingEngine, Validator } from '../domain/engine.js';
import { AppError } from '../domain/errors.js';
import { terminalStates } from '../domain/lifecycle.js';
import { EngineRegistry } from '../engines/registry.js';
import { CodexDependencyInstaller } from '../engines/codex/preparation.js';
import { NodeEnvironmentPreparer, type EnvironmentPreparer } from '../workspace/environment.js';
import { assertDiskSpace, DATABASE_HEADROOM } from '../workspace/disk-space.js';
import { log, redact } from '../telemetry/redact.js';
import type { TaskService } from './service.js';
import { TaskWorkflows } from './workflows.js';
import { TaskExecution } from './task-execution.js';
import { ExecutionResources } from './resources.js';
export { SHUTDOWN_REASON } from './task-execution.js';

type Active = { execution: TaskExecution; promise: Promise<void>; claim: DispatchClaim; drained: boolean };
/** One local scheduler, durable requests, and independently owned task executions. */
export class TaskRunner {
  private readonly owner = randomUUID();
  private readonly active = new Map<string, Active>();
  private readonly engines: EngineRegistry;
  private readonly resources: ExecutionResources;
  private readonly poll: ReturnType<typeof setInterval>;
  private checking: Promise<void> | undefined;
  private stopping = false;
  private recovering = false;
  private closing?: Promise<void>;
  executionFailure: { taskId: string; message: string } | undefined;
  readonly workflows: TaskWorkflows;
  constructor(private readonly service: TaskService, engine: CodingEngine | EngineRegistry,
    private readonly validator: Validator, private readonly environment?: EnvironmentPreparer, options: { startPaused?: boolean } = {}) {
    this.recovering = options.startPaused ?? false;
    this.engines = engine instanceof EngineRegistry ? engine : new EngineRegistry([engine]);
    this.resources = new ExecutionResources(service.dataDir, service.config.maxConcurrentOperations, service.config.minFreeDiskBytes);
    const context = (id: string) => {
      const active = this.active.get(id);
      if (!active) throw new AppError('workflow_ownership', 'Workflow does not own an active task slot');
      return active.execution;
    };
    this.workflows = new TaskWorkflows(service, {
      prepare: async id => { if (service.store.task(id).state !== 'awaiting_plan_approval') await context(id).prepare(id, context(id).abort.signal); },
      plan: id => context(id).plan(id, context(id).abort.signal),
      environment: id => context(id).prepareApprovedEnvironment(),
      execute: id => context(id).execute(id, context(id).abort.signal),
    });
    this.poll = setInterval(() => {
      this.drain();
      if (!this.stopping && !this.executionFailure && !this.recovering) {
        try { for (const active of this.active.values()) this.service.store.heartbeatDispatch(active.claim); }
        catch (error) { this.halt('ownership', error); }
      }
      if (!this.active.size || this.checking || this.stopping || this.executionFailure) return;
      this.checking = assertDiskSpace(service.dataDir, DATABASE_HEADROOM).catch(async error => {
        if (!this.stopping) { await service.diskReserve.release().catch(() => {}); this.halt('storage', error); }
      }).finally(() => { this.checking = undefined; });
    }, 1000); this.poll.unref();
  }
  enqueue(id: string): void {
    this.service.assertNotMaintaining(id);
    if (this.executionFailure) throw new AppError('execution_halted', 'Execution halted; recover storage and restart the service before submitting more work', 503);
    if (this.stopping) throw new AppError('stopping', 'Service is shutting down', 503);
    this.service.store.requestDispatch(id); this.drain();
  }
  cancel(id: string): void {
    this.service.assertNotMaintaining(id); this.active.get(id)?.execution.abort.abort();
    if (!this.executionFailure && !this.stopping) { this.service.store.requestDispatch(id); this.drain(); }
  }
  stop(): Promise<void> {
    this.closing ??= (async () => {
      this.stopping = true; clearInterval(this.poll);
      for (const active of this.active.values()) active.execution.abort.abort();
      await this.idle(); await this.checking; await this.workflows.close();
    })(); return this.closing;
  }
  isDrained(id: string): boolean {
    return (!this.active.has(id) || this.active.get(id)!.drained) && !this.service.store.pendingDispatches().includes(id) && this.workflows.isDrained(id);
  }
  get busy(): boolean { return Boolean(this.active.size || this.service.store.pendingDispatches().length); }
  async idle(): Promise<void> {
    this.drain();
    while (this.active.size) await Promise.all([...this.active.values()].map(a => a.promise));
  }
  /** Only invoked under the local service lock; active effects are never replayed. */
  async recover(): Promise<void> {
    if (this.active.size) throw new AppError('recovery_active', 'Recovery requires a stopped scheduler', 409);
    this.recovering = true;
    try {
      this.service.store.recover();
      for (const task of this.service.store.tasks()) {
        const queue = this.service.store.dispatch(task.id);
        if (queue?.blocker) { if (terminalStates.includes(task.state)) await this.workflows.run(task.id); continue; }
        const snapshot = await this.workflows.state(task.id);
        const safeWait = snapshot?.status === 'suspended' && ['awaiting_mode', 'awaiting_plan_approval'].includes(task.state);
        const uncertain = queue?.owner && !safeWait
          && this.service.store.evidence(task.id).some(e => ['worktree-intent', 'run-started', 'commit-intent'].includes(e.kind));
        if (uncertain) {
          this.service.store.recoverDispatch(task.id, 'Prior execution did not record completion; worker termination is unverified. Inspect retained work before cleanup.');
          continue;
        }
        this.service.store.recoverDispatch(task.id);
        if (terminalStates.includes(task.state)) { await this.workflows.run(task.id); await this.service.cleanupTerminalTask(task.id); }
        else if (['awaiting_mode', 'awaiting_plan_approval'].includes(task.state)) this.service.store.requestDispatch(task.id, true);
        else if (['planning', 'ready'].includes(task.state)) this.service.store.requestDispatch(task.id, true);
      }
    } finally {
      this.recovering = false;
    }
    this.drain();
  }
  private drain(): void {
    if (this.stopping || this.executionFailure || this.recovering) return;
    while (this.active.size < this.service.config.maxConcurrentTasks) {
      let claim: DispatchClaim | undefined;
      try { claim = this.service.store.claimDispatch(this.owner, new Set(this.active.keys())); }
      catch (error) { this.halt('scheduler', error); return; }
      if (!claim) return;
      const id = claim.taskId;
      const validator: Validator = {
        ...(this.validator.preflight ? { preflight: (cwd, commands, signal, rules) => this.resources.run(id, signal, () => this.validator.preflight!(cwd, commands, signal, rules)) } : {}),
        execute: (cwd, command, signal, timeout, rules) => this.resources.run(id, signal, () => this.validator.execute(cwd, command, signal, timeout, rules)),
      };
      const environment = this.environment ?? new NodeEnvironmentPreparer(this.service.dataDir,
        new CodexDependencyInstaller(this.service.dataDir, 'codex', { scanLimit: this.service.config.workspaceScanLimit, minFreeDiskBytes: this.service.config.minFreeDiskBytes }));
      const execution = new TaskExecution(id, this.service, this.engines, validator, environment, this.workflows, this.resources, () => this.stopping);
      const active: Active = { execution, claim, drained: false, promise: Promise.resolve() };
      this.active.set(id, active);
      active.promise = Promise.resolve().then(() => this.service.store.withDispatch(active.claim, async () => {
        await this.service.diskReserve.replenish(); await execution.run();
      })).catch(error => this.halt(id, error)).finally(async () => {
          try {
            await this.workflows.drain(id); active.drained = true;
            if (!this.executionFailure) {
              await this.service.store.withDispatch(active.claim, () => this.service.cleanupTerminalTask(id));
              this.service.store.finishDispatch(active.claim);
            }
          } catch (error) { this.halt(id, error); }
          finally { this.active.delete(id); this.drain(); }
        });
    }
  }
  private halt(id: string, error: unknown): void {
    const message = String(redact(error instanceof Error ? error.message : String(error), this.service.store.secrets)).slice(0, 2000);
    this.executionFailure ??= { taskId: id, message };
    for (const active of this.active.values()) active.execution.abort.abort(new AppError('execution_halted', message, 503));
    void this.service.diskReserve.release().catch(() => {});
    try { log('execution_halted', { taskId: id, message }); } catch { /* stderr can fail too */ }
  }
}
