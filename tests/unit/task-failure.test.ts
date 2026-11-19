import test from 'node:test';
import assert from 'node:assert/strict';
import { taskFailure } from '../../ui/src/task-failure.js';
import type { Evidence } from '../../ui/src/api.js';

const report = (summary: string, workItemId?: string): Evidence => ({ sequence: 1, at: '2026-11-19T08:48:54Z', kind: 'run-completed', data: { phase: 'implementation', ...(workItemId ? { workItemId } : {}), output: { summary } } });
const failed = (error: string) => ({ outcome: { error, repairCycles: 0 } });

test('historical empty changes explain the gate and attribute the developer report without declaring success', () => {
  const result = taskFailure(failed('Implementation produced no reviewable changes'), [report('The requested behavior already exists. No changes needed.\n\nTests passed.')]);
  assert.match(result.reason, /requires a code change/);
  assert.match(result.reason, /before automated validation and independent review/);
  assert.equal(result.report, 'The requested behavior already exists. No changes needed.');
  assert.match(result.nextStep, /verify it before closing/);
  assert.doesNotMatch(result.nextStep, /setup/);
  assert.equal(taskFailure(failed('Implementation produced no reviewable changes. DevAgents requires a code change to complete a task.'), []).title, result.title);
  assert.doesNotMatch(taskFailure(failed('No changes to commit'), []).reason, /before automated validation/);
});

test('empty changes without a developer report never assert the request is already implemented', () => {
  const result = taskFailure(failed('Implementation produced no reviewable changes'), []);
  assert.equal(result.report, undefined);
  assert.doesNotMatch(result.reason, /already exists|already implemented/);
});

test('DAG failure uses only the failed item report, including bounded metadata', () => {
  const relevant = report('Already present.', 'frontend');
  const bounded = { ...relevant, data: { preview: 'truncated', bytes: 100000 }, metadata: relevant.data as Record<string, unknown>, truncated: true };
  const result = taskFailure(failed('Work item frontend produced no changes'), [bounded, report('Backend work done.', 'backend')]);
  assert.equal(result.report, 'Already present.');
  assert.match(result.reason, /Work item “frontend”/);
  const combined = taskFailure(failed('Combined task has no changes'), [report('Unrelated item report.')]);
  assert.equal(combined.report, undefined);
  assert.match(combined.reason, /combined validation/);
});

test('unknown errors and missing history remain honest; cancelled tasks are not reclassified here', () => {
  const result = taskFailure(failed('Unable to read repository'), []);
  assert.equal(result.reason, 'Unable to read repository');
  assert.equal(result.report, undefined);
  assert.match(taskFailure({}, []).reason, /No failure reason was saved/);
  assert.match(taskFailure(failed('Repair budget exhausted. Test failed'), []).title, /repair attempts/);
  assert.match(taskFailure(failed('Service shutdown interrupted execution'), []).title, /shutdown/);
});
