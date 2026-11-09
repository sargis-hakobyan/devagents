import test from 'node:test';
import assert from 'node:assert/strict';
import { admittedWorkers, assertDiskSpace, DATABASE_HEADROOM } from '../../src/workspace/disk-space.js';

test('insufficient disk headroom is an explicit failure, never a passed or advisory check', async () => {
  await assert.rejects(assertDiskSpace('/fixture', DATABASE_HEADROOM, async () => 0), { code: 'disk_space_low', status: 507 });
  await assertDiskSpace('/fixture', DATABASE_HEADROOM, async () => DATABASE_HEADROOM);
  await assert.rejects(assertDiskSpace('/fixture', DATABASE_HEADROOM, async () => { throw new Error('Cannot measure'); }), /Cannot measure/);
});


test('parallel admission budgets each new checkout instead of promising the same free bytes to every worker', async () => {
  assert.equal(await admittedWorkers('/fixture', 4, 5, async () => 11), 2);
  assert.equal(await admittedWorkers('/fixture', 4, 5, async () => 5), 1);
  await assert.rejects(admittedWorkers('/fixture', 2, 5, async () => 4), { code: 'disk_space_low' });
});
