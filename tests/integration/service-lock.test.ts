import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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

test('a full disk is reported as a storage failure rather than another service', async t => {
  const f = await fixture();
  try {
    const sqliteFull = Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR', errcode: 13 });
    const exec = t.mock.method(DatabaseSync.prototype, 'exec', () => { throw sqliteFull; });
    try {
      assert.throws(() => lockService(f.dataDir), {
        code: 'disk_space_low', status: 507, message: /data disk is full/,
      });
    } finally { exec.mock.restore(); }
    // The failed attempt must close its database so a later attempt can succeed.
    const release = lockService(f.dataDir); release();
  } finally { await f.cleanup(); }
});

test('a damaged lock database preserves its diagnostic rather than claiming contention', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.dataDir, 'service-lock.db'), 'invalid SQLite database\n'.repeat(100));
    assert.throws(() => lockService(f.dataDir), { code: 'ERR_SQLITE_ERROR', message: /not a database/ });
  } finally { await f.cleanup(); }
});
