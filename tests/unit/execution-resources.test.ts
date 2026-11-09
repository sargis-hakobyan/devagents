import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionResources, OperationPool } from '../../src/orchestration/resources.js';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

test('operation permits are bounded, FIFO, abortable and released on failure', async () => {
  const pool = new OperationPool(1); const signal = new AbortController().signal;
  const first = deferred(); const started = deferred(); const order: number[] = [];
  const a = pool.run(signal, async () => { order.push(1); started.resolve(); await first.promise; });
  await started.promise;
  const cancelled = new AbortController();
  const b = pool.run(cancelled.signal, async () => { order.push(2); });
  const rejected = assert.rejects(b, { name: 'AbortError' }); cancelled.abort();
  const c = pool.run(signal, async () => { order.push(3); throw new Error('Fixture failure'); });
  const failed = assert.rejects(c, /Fixture failure/);
  const d = pool.run(signal, async () => { order.push(4); });
  assert.equal(pool.running, 1); assert.equal(pool.waiting, 2);
  first.resolve(); await Promise.all([a, rejected, failed, d]);
  assert.deepEqual(order, [1, 3, 4]); assert.equal(pool.running, 0);
});

test('preparation cannot reserve the same observed disk headroom twice', async () => {
  const resources = new ExecutionResources('/fixture', 2, 100, async () => 150);
  const signal = new AbortController().signal;
  const release = await resources.preparation('a', signal);
  const waiting = resources.preparation('b', signal);
  // Flush the measurement transaction, rather than wait an arbitrary duration.
  const cancel = new AbortController(); const last = resources.preparation('c', cancel.signal);
  const rejected = assert.rejects(last, { name: 'AbortError' }); cancel.abort(); await rejected;
  assert.equal(resources.waiting.get('b'), 'disk');
  release(); (await waiting)(); release();
  assert.equal(resources.waiting.size, 0);
});
