import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeLimitations, describeLimitations, LIMITATION_LIMIT } from '../../src/domain/limitations.js';
import { ImplementationOutput, ReviewOutput } from '../../src/orchestration/outputs.js';
import { Plan } from '../../src/domain/schemas.js';

const plan = { summary: 's', risks: [], items: [{ id: 'one', title: 't', description: 'd', acceptanceCriteria: ['a'], dependsOn: [], requiredCapabilities: ['implementation'], projectId: 'fixture', branch: 'codex/one', validation: [{ executable: 'node', args: ['--test'] }] }] };

test('limitations are optional reports with bounds; a rejection still needs findings', () => {
  assert.deepEqual(ImplementationOutput.parse({ summary: 'done' }).limitations, []);
  assert.deepEqual(ImplementationOutput.parse({ summary: 'done', limitations: ['No browser'] }).limitations, ['No browser']);
  assert.throws(() => ImplementationOutput.parse({ summary: 'done', limitations: Array.from({ length: 11 }, () => 'x') }));
  assert.throws(() => ImplementationOutput.parse({ summary: 'done', limitations: ['x'.repeat(1001)] }));
  const review = ReviewOutput.parse({ approved: true, summary: 'ok', findings: [], limitations: ['Screenshots not taken: no Chromium'] });
  assert.equal(review.approved, true); assert.equal(review.limitations.length, 1);
  assert.throws(() => ReviewOutput.parse({ approved: false, summary: 'no', findings: [], limitations: ['x'] }), /at least one actionable finding/);
  assert.equal(Plan.parse(plan).manualChecks, undefined);
  assert.deepEqual(Plan.parse({ ...plan, manualChecks: ['Check the layout at 390 px'] }).manualChecks, ['Check the layout at 390 px']);
  assert.throws(() => Plan.parse({ ...plan, manualChecks: Array.from({ length: 11 }, () => 'x') }));
});
test('merging deduplicates case-insensitively, trims, and stays bounded', () => {
  assert.deepEqual(mergeLimitations(['No browser '], ['no browser', 'No network'], undefined, ['']), ['No browser', 'No network']);
  assert.equal(mergeLimitations(Array.from({ length: 40 }, (_, i) => `check ${i}`)).length, LIMITATION_LIMIT);
  assert.equal(describeLimitations([]), ''); assert.equal(describeLimitations(['a']), ' · 1 check not run in this environment'); assert.equal(describeLimitations(['a', 'b']), ' · 2 checks not run in this environment');
});
