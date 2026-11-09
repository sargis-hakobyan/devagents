import { AppError } from '../domain/errors.js';
import { availableDiskBytes } from '../workspace/disk-space.js';

/** FIFO, abortable operation permits shared by all tasks in one service. */
export class OperationPool {
  private active = 0;
  private readonly queue: { grant(): void; cancel(): void }[] = [];
  constructor(readonly limit: number) {}
  async run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) { reject(signal.reason); return; }
      const waiter = { grant: () => { signal.removeEventListener('abort', abort); this.active++; resolve(); },
        cancel: () => { const index = this.queue.indexOf(waiter); if (index >= 0) this.queue.splice(index, 1); reject(signal.reason); } };
      const abort = () => waiter.cancel();
      signal.addEventListener('abort', abort, { once: true }); this.queue.push(waiter); this.drain();
    });
    try { signal.throwIfAborted(); return await work(); }
    finally { this.active--; this.drain(); }
  }
  private drain(): void { while (this.active < this.limit && this.queue.length) this.queue.shift()!.grant(); }
  get running(): number { return this.active; }
  get waiting(): number { return this.queue.length; }
}

export class ExecutionResources {
  readonly operations: OperationPool;
  private reserved = 0;
  private measuring: Promise<void> = Promise.resolve();
  private readonly changed = new Set<() => void>();
  readonly waiting = new Map<string, 'operations' | 'disk'>();
  constructor(private readonly dataDir: string, limit: number, private readonly headroom: number,
    private readonly readDisk = availableDiskBytes) { this.operations = new OperationPool(limit); }
  async run<T>(taskId: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    this.waiting.set(taskId, 'operations');
    return this.operations.run(signal, async () => { this.waiting.delete(taskId); return work(); })
      .finally(() => this.waiting.delete(taskId));
  }
  /** Reserve admission headroom while preparing; installed bytes are measured on the next admission. */
  async preparation(taskId: string, signal: AbortSignal): Promise<() => void> {
    while (true) {
      signal.throwIfAborted();
      let granted = false;
      const measurement = this.measuring.then(async () => {
        signal.throwIfAborted(); const available = await this.readDisk(this.dataDir);
        if (available - this.reserved >= this.headroom) { this.reserved += this.headroom; granted = true; }
        else if (!this.reserved) throw new AppError('disk_space_low', 'Insufficient disk space for environment preparation');
      });
      this.measuring = measurement.catch(() => {}); await measurement;
      if (granted) {
        this.waiting.delete(taskId); let released = false;
        return () => { if (released) return; released = true; this.reserved -= this.headroom; for (const wake of [...this.changed]) wake(); };
      }
      this.waiting.set(taskId, 'disk');
      await new Promise<void>((resolve, reject) => {
        const wake = () => { this.changed.delete(wake); signal.removeEventListener('abort', abort); resolve(); };
        const abort = () => { this.changed.delete(wake); this.waiting.delete(taskId); reject(signal.reason); };
        this.changed.add(wake); signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort(); else if (!this.reserved) wake();
      });
    }
  }
}
