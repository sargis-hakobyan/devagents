import { AppError } from '../domain/errors.js';
import { terminalStates } from '../domain/lifecycle.js';
import type { PostgresTasks } from '../persistence/postgres-tasks.js';
import type { TaskService } from './service.js';

/** SQLite holds the frozen local execution context. Only the committed PostgreSQL claim opens its dispatch gate. */
export class SharedTasks {
  private readonly active = new Map<string, Promise<void>>();
  private timer?: ReturnType<typeof setInterval>;
  private sweep?: Promise<void>;
  private lastFailure: string | null = null;
  constructor(private readonly service: TaskService, private readonly database: PostgresTasks) {
    service.enableSharedSubmissions(database.ownerId);
  }

  start() {
    const poll = () => {
      if (!this.sweep) this.sweep = this.reconcile().finally(() => { delete this.sweep; });
    };
    this.timer = setInterval(poll, 1000);
    this.timer.unref();
    poll();
  }
  private async reconcile() {
    try {
      let failed = false;
      for (const id of this.service.store.outstandingHandoffs()) {
        try { await this.sync(id); } catch { failed = true; }
      }
      this.lastFailure = failed ? 'Shared task handoff pending. Check PostgreSQL connectivity and claim ownership.' : null;
    } catch { this.lastFailure = 'Local task handoff storage unavailable.'; }
  }
  async publish(id: string) {
    const job = this.service.store.sharedHandoff(id);
    if (!job || job.phase !== 'held') return;
    if (job.ownerId !== this.database.ownerId) throw new AppError('workspace_forbidden', 'Shared task belongs to another workspace', 403);
    await this.database.publish({ ...job, id, snapshot: JSON.parse(job.snapshot!) });
  }
  get problem() { return this.lastFailure; }
  sync(id: string): Promise<void> {
    const current = this.active.get(id);
    if (current) return current;
    const work = this.process(id).finally(() => this.active.delete(id));
    this.active.set(id, work);
    return work;
  }
  private async process(id: string) {
    const store = this.service.store;
    const job = store.sharedHandoff(id);
    if (!job || job.phase === 'archived') return;
    if (job.ownerId !== this.database.ownerId) throw new AppError('workspace_forbidden', 'Shared task belongs to another workspace', 403);
    if (job.phase === 'held') {
      await this.publish(id);
      await this.database.claim(id, job.claimId);
      store.advanceHandoff(id, job.ownerId, job.claimId, 'held');
      this.service.admitSubmission(store.task(id));
    }
    const task = store.task(id);
    if (!terminalStates.includes(task.state)) return;
    const diff = task.outcome?.commit ? await this.service.diff(id).catch(error => {
      if (error instanceof AppError && error.code === 'diff_unavailable') return null;
      throw error;
    }) : null;
    await this.database.finish(id, job.claimId, { ownerId: job.ownerId, task, diff });
    store.advanceHandoff(id, job.ownerId, job.claimId, 'released');
  }

  async result(id: string) {
    const archived = await this.database.result(id);
    if (archived) return archived;
    const job = this.service.store.sharedHandoff(id);
    if (job?.phase !== 'released' || !terminalStates.includes(this.service.store.task(id).state)) return undefined;
    await this.sync(id);
    return this.database.result(id);
  }
  async stop() {
    clearInterval(this.timer);
    await this.sweep;
    await Promise.allSettled(this.active.values());
    await this.database.close();
  }
}
