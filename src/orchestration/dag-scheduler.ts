import { AppError } from '../domain/errors.js';

type Node = { id: string; dependsOn: string[]; agentId: string; agentConcurrency: number };
/** Select dependency-ready items within the remaining task and per-agent capacity. */
export function readyItems(nodes: Node[], done: Set<string>, concurrency: number, running: ReadonlySet<string> = new Set()): Node[] {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new AppError('invalid_concurrency', 'Concurrency must be positive');
  const active = new Map<string, number>(); const ready: Node[] = [];
  for (const node of nodes) if (running.has(node.id)) active.set(node.agentId, (active.get(node.agentId) ?? 0) + 1);
  for (const node of nodes) {
    if (running.size + ready.length >= concurrency) break;
    if (done.has(node.id) || running.has(node.id) || !node.dependsOn.every(id => done.has(id))) continue;
    if ((active.get(node.agentId) ?? 0) >= node.agentConcurrency) continue;
    ready.push(node); active.set(node.agentId, (active.get(node.agentId) ?? 0) + 1);
  }
  if (!ready.length && !running.size && done.size < nodes.length) throw new AppError('scheduler_stalled', 'No schedulable work items remain');
  return ready;
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
