import { AppError } from '../domain/errors.js';

type Node = { id: string; dependsOn: string[]; agentId: string; agentConcurrency: number };
/** Deterministic bounded waves; integration finishes before dependents are released. */
export function readyWave(nodes: Node[], done: Set<string>, concurrency: number): Node[] {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new AppError('invalid_concurrency', 'Concurrency must be positive');
  const active = new Map<string, number>(); const wave: Node[] = [];
  for (const node of nodes) {
    if (done.has(node.id) || !node.dependsOn.every(id => done.has(id))) continue;
    if ((active.get(node.agentId) ?? 0) >= node.agentConcurrency) continue;
    wave.push(node); active.set(node.agentId, (active.get(node.agentId) ?? 0) + 1);
    if (wave.length === concurrency) break;
  }
  if (!wave.length && done.size < nodes.length) throw new AppError('scheduler_stalled', 'No schedulable work items remain');
  return wave;
}
/** Limit shared reviewer invocations without blocking cancellation while queued. */
export class AgentSlots {
  private active = new Map<string, number>();
  private waiters = new Set<() => void>();
  async run<T>(id: string, limit: number, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    while ((this.active.get(id) ?? 0) >= limit) {
      if (signal.aborted) throw new AppError('cancelled', 'Task cancelled');
      await new Promise<void>((resolve, reject) => {
        const wake = () => { this.waiters.delete(wake); signal.removeEventListener('abort', abort); resolve(); };
        const abort = () => { this.waiters.delete(wake); signal.removeEventListener('abort', abort); reject(new AppError('cancelled', 'Task cancelled')); };
        this.waiters.add(wake); signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
    if (signal.aborted) throw new AppError('cancelled', 'Task cancelled');
    this.active.set(id, (this.active.get(id) ?? 0) + 1);
    try { return await work(); }
    finally { this.active.set(id, this.active.get(id)! - 1); for (const wake of [...this.waiters]) wake(); }
  }
}
