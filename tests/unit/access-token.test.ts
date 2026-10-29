import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { accessToken } from '../../src/api/server.js';

test('the data directory is tightened to 0700 on every start and the token stays private and stable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'access-token-')); const dataDir = join(root, 'data');
  try {
    const first = await accessToken(dataDir);
    assert.equal((await stat(dataDir)).mode & 0o777, 0o700); assert.equal((await stat(join(dataDir, 'api-token'))).mode & 0o777, 0o600);
    await chmod(dataDir, 0o755); await chmod(join(dataDir, 'api-token'), 0o644);
    const second = await accessToken(dataDir);
    assert.equal(second, first); assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal((await stat(dataDir)).mode & 0o777, 0o700); assert.equal((await stat(join(dataDir, 'api-token'))).mode & 0o777, 0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});
