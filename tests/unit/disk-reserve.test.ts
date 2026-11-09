import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskReserve, EMERGENCY_RESERVE_BYTES } from '../../src/workspace/disk-reserve.js';

test('emergency reserve allocates real blocks, releases idempotently and refuses aliases', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devagents-reserve-'));
  try {
    const reserve = new DiskReserve(dir); const path = join(dir, 'database-emergency-reserve');
    await reserve.replenish(); const original = await lstat(path);
    assert.equal(original.size, EMERGENCY_RESERVE_BYTES); assert.ok(original.blocks * 512 >= EMERGENCY_RESERVE_BYTES);
    await reserve.replenish(); assert.equal((await lstat(path)).ino, original.ino);
    await reserve.release(); await reserve.release(); await assert.rejects(lstat(path), { code: 'ENOENT' });
    const outside = join(dir, 'keep'); await writeFile(outside, 'Preserve'); await symlink(outside, path);
    await assert.rejects(reserve.release(), /private regular file/); await assert.rejects(reserve.replenish(), /private regular file/);
    assert.equal(await readFile(outside, 'utf8'), 'Preserve');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
