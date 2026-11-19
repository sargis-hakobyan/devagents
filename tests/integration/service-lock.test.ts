import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { PgSession } from '../../src/persistence/pg-session.js';
import { fixture } from '../helpers.js';
import { lockService } from '../../src/persistence/service-lock.js';

test('one service owns a data directory and its lock releases after a crash', async () => {
  const f = await fixture();
  const child = fork('tests/fixtures/lock-holder.ts', [f.dataDir], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try {
    await once(child, 'message', { signal: AbortSignal.timeout(10000) });
    await assert.rejects(async () => await lockService(f.dataDir), /Another service owns/);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    const release = await lockService(f.dataDir); await release();
  } finally { child.kill('SIGKILL'); await f.cleanup(); }
});

test('connection failures preserve their diagnostic', async t => {
  const f = await fixture();
  try {
    const query = t.mock.method(PgSession.prototype, 'prepare', () => { throw Error('connection closed'); });
    try { await assert.rejects(async () => await lockService(f.dataDir), /connection closed/); }
    finally { query.mock.restore(); }
    await (await lockService(f.dataDir))();
  } finally { await f.cleanup(); }
});

test('a runtime whose database lease disconnects exits before its replacement can recover work', async () => {
  const f = await fixture();
  const { join } = await import('node:path');
  const child = fork('tests/fixtures/lock-holder.ts', [f.dataDir], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try {
    await once(child, 'message', { signal: AbortSignal.timeout(10000) });
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(10000) });
    const inspector = await PgSession.open(join(f.dataDir, 'devagents.db'));
    try {
      assert.equal((await inspector.prepare('SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity WHERE application_name=$1')
        .get('devagents-lock:' + inspector.workspaceId))?.killed, true);
    } finally { await inspector.close(); }
    assert.equal((await exited)[1], 'SIGKILL');
    await (await lockService(f.dataDir))();
  } finally { child.kill('SIGKILL'); await f.cleanup(); }
});
