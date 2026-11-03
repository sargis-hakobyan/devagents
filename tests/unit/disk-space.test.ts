import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDiskSpace, DATABASE_HEADROOM } from '../../src/workspace/disk-space.js';

test('insufficient disk headroom is an explicit failure, never a passed or advisory check', async () => {
  await assert.rejects(assertDiskSpace('/fixture', DATABASE_HEADROOM, async () => 0), { code: 'disk_space_low', status: 507 });
  await assertDiskSpace('/fixture', DATABASE_HEADROOM, async () => DATABASE_HEADROOM);
  await assert.rejects(assertDiskSpace('/fixture', DATABASE_HEADROOM, async () => { throw new Error('Cannot measure'); }), /Cannot measure/);
});
