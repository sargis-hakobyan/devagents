import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createApi } from '../../src/api/server.js';
import { Store } from '../../src/persistence/store.js';
import { TaskService } from '../../src/orchestration/service.js';
import { Config } from '../../src/domain/schemas.js';
import { fixture } from '../helpers.js';

test('task concurrency validates authenticated updates, rejects stale writes and persists over startup defaults', async () => {
  const f = await fixture(); const server = createApi(f.service, 'test-token');
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/settings/task-concurrency`;
  const headers = { authorization: 'Bearer test-token', 'content-type': 'application/json' };
  const put = (body: unknown, h = headers) => fetch(url, { method: 'PUT', headers: h, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await put({ maxConcurrentTasks: 2, expectedVersion: 0 }, { ...headers, authorization: '' })).status, 401);
    assert.equal((await put({ maxConcurrentTasks: 2, expectedVersion: 0 }, { ...headers, origin: 'https://attacker.invalid' } as typeof headers)).status, 403);
    assert.deepEqual(await (await fetch(url, { headers })).json(), { maxConcurrentTasks: 1, version: 0 });
    for (const value of [0, 9, 1.5, '2', null]) assert.equal((await put({ maxConcurrentTasks: value, expectedVersion: 0 })).status, 400);
    assert.equal((await put({ expectedVersion: 0 })).status, 400);
    assert.deepEqual(await (await put({ maxConcurrentTasks: 2, expectedVersion: 0 })).json(), { maxConcurrentTasks: 2, version: 1 });
    assert.equal(f.service.scheduling().maxConcurrentTasks, 2);
    assert.equal((await put({ maxConcurrentTasks: 3, expectedVersion: 0 })).status, 409);
    await writeFile(join(f.dataDir, 'api-token'), 'test-token', { mode: 0o600 });
    const cli = (...args: string[]) => promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', 'config', 'task-concurrency', ...args], {
      env: { ...process.env, DEVAGENTS_DATA_DIR: f.dataDir, DEVAGENTS_PORT: String((server.address() as AddressInfo).port) },
    });
    assert.equal(JSON.parse((await cli()).stdout).maxConcurrentTasks, 2);
    assert.equal(JSON.parse((await cli('3')).stdout).maxConcurrentTasks, 3);
    await assert.rejects(cli('9'));
    assert.equal(f.service.taskConcurrency().maxConcurrentTasks, 3);
    const reopened = new Store(join(f.dataDir, 'test.db'));
    try {
      const service = new TaskService(reopened, Config.parse({ schemaVersion: 1, maxConcurrentTasks: 4 }), f.dataDir);
      assert.deepEqual(service.taskConcurrency(), { maxConcurrentTasks: 3, version: 2 });
      assert.equal(service.config.maxConcurrentOperations, 2);
    } finally { reopened.close(); }
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await f.cleanup(); }
});
