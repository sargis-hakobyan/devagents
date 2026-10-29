import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fixture } from '../helpers.js';
import { lockService } from '../../src/persistence/service-lock.js';

test('one service owns a data directory and its lock releases after a crash', async () => {
  const f = await fixture();
  const child = fork('tests/fixtures/lock-holder.ts', [f.dataDir], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try {
    await once(child, 'message', { signal: AbortSignal.timeout(10000) });
    assert.throws(() => lockService(f.dataDir), /Another service owns/);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    const release = lockService(f.dataDir); release();
  } finally { child.kill('SIGKILL'); await f.cleanup(); }
});
