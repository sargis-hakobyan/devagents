import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { fixture } from '../helpers.js';

test('committed task and its event survive an abrupt writer process termination', async () => {
  const f = await fixture();
  const child = fork('tests/fixtures/crash-writer.ts', [join(f.dataDir, 'test.db')], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try {
    const message = await once(child, 'message', { signal: AbortSignal.timeout(10000) });
    const id = (message[0] as { id: string }).id;
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    assert.equal(f.store.task(id).state, 'awaiting_mode');
    assert.equal(f.store.events(id).length, 1);
    assert.equal(f.service.submit({ projectId: 'fixture', request: 'Survive a process crash' }, 'crash-test').id, id);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await f.cleanup();
  }
});
