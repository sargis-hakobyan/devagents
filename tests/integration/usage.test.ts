import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { fixture } from '../helpers.js';
import { Config } from '../../src/domain/schemas.js';
import { normalizeUsage, priceFor, taskUsage } from '../../src/domain/usage.js';
import type { TaskUsage } from '../../src/domain/usage-types.js';
import { createApi } from '../../src/api/server.js';

const price = { inputPerMillion: 2, cachedInputPerMillion: 0.5, outputPerMillion: 8, asOf: '2026-11-03' };
const usage = { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 100 };
test('usage normalizes cache subsets, rejects invalid numbers and never treats missing usage as zero', () => {
  assert.deepEqual(normalizeUsage(usage), { input: 1000, cachedInput: 800, output: 100, total: 1100 });
  assert.equal(normalizeUsage({ ...usage, cached_input_tokens: 1001 }), null);
  assert.equal(normalizeUsage({ ...usage, input_tokens: -1 }), null);
  assert.equal(normalizeUsage({ ...usage, output_tokens: 0.5 }), null);
  assert.equal(normalizeUsage({ input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 }), null);
  assert.equal(normalizeUsage({}), null);
  assert.equal(normalizeUsage({ input_tokens: 1000, output_tokens: 100 })?.cachedInput, null);
  assert.equal(normalizeUsage({ input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 })?.total, 0);
  assert.equal(priceFor('constructor', Config.parse({ schemaVersion: 1 })), null);
  assert.throws(() => Config.parse({ schemaVersion: 1, usagePricing: { eur: { usdToEur: 0, asOf: 'invalid' } } }));
});

test('authenticated usage endpoint counts each attempt once, retains failed usage and excludes large evidence', async () => {
  const f = await fixture(); const server = createApi(f.service, 'synthetic-usage-token');
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Usage fixture', mode: 'autonomous' }, 'usage');
    const start = (runId: string, extra = {}) => f.store.record(task.id, 'run-started', { runId, phase: 'review', workItemId: 'item-a', agentId: 'reviewer', model: 'fixture-model', providerKind: 'openai', auth: 'api-key', usagePrice: price, ...extra });
    start('one');
    f.store.record(task.id, 'progress', { runId: 'one', kind: 'usage', data: usage });
    f.store.record(task.id, 'run-completed', { runId: 'one', usage, output: 'fixture-secret-value' + 'x'.repeat(100000) });
    for (let i = 0; i < 1001; i++) f.store.record(task.id, 'progress', { runId: 'one', kind: 'command', data: { output: 'command output' } });
    start('two', { auth: 'login' });
    f.store.record(task.id, 'progress', { runId: 'two', kind: 'started', data: { billing: 'subscription' } });
    f.store.record(task.id, 'progress', { runId: 'two', kind: 'usage', data: usage });
    f.store.record(task.id, 'run-failed', { runId: 'two', error: 'Invalid final output' });
    start('three', { model: 'default', usagePrice: null });
    f.store.record(task.id, 'run-completed', { runId: 'three', usage });
    start('four'); // cancelled before usage was reported
    start('five'); f.store.record(task.id, 'run-completed', { runId: 'five', usage: { input_tokens: 10, output_tokens: 3 } });
    f.service.cancel(task.id);
    const url = `${origin}/tasks/${task.id}/usage`;
    assert.equal((await fetch(url)).status, 401);
    const response = await fetch(url, { headers: { authorization: 'Bearer synthetic-usage-token' } });
    assert.equal(response.status, 200); const result = await response.json() as TaskUsage;
    assert.equal(result.runs.length, 5);
    assert.deepEqual(result.runs.map(r => r.attempt), [1, 2, 3, 4, 5]);
    assert.equal(result.runs[1]!.status, 'failed'); assert.equal(result.runs[3]!.status, 'interrupted');
    assert.equal(result.totals.total, 3313); // cached input is not added again
    assert.equal(result.totals.missingRuns, 1); assert.equal(result.totals.missingCacheRuns, 1);
    assert.equal(result.totals.pricedRuns, 2); assert.equal(result.totals.unpricedRuns, 3);
    assert.equal(result.totals.apiEstimatedUsd, 0.0016); assert.equal(result.totals.equivalentEstimatedUsd, 0.0016);
    assert.match(result.runs[2]!.unavailableReason!, /model was not recorded/);
    assert.match(result.runs[4]!.unavailableReason!, /Cached input/);
    assert.doesNotMatch(JSON.stringify(result), /command output|fixture-secret-value|xxxx/);
    // Changing today's rates cannot rewrite the recorded per-run estimate.
    const changed = taskUsage(f.store.task(task.id), f.store.usageEvidence(task.id), Config.parse({ schemaVersion: 1, usagePricing: { models: { 'fixture-model': { ...price, inputPerMillion: 99 } } } }));
    assert.equal(changed.runs[0]!.estimatedUsd, 0.0016);
    assert.equal(changed.runs[2]!.price, null);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.cleanup(); }
});

test('historical usage uses only saved models and provider identity, with independent work-item attempt counters', async () => {
  const f = await fixture();
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Historical usage', mode: 'autonomous' }, 'legacy');
    const members = (await f.service.templates()).map(m => ({ ...m, model: 'gpt-5.3-codex' }));
    const saved = { ...task, team: { id: 'fixture', revision: 1, name: 'Fixture', snapshotAt: task.createdAt, members, providers: [{ id: 'openai', kind: 'openai' as const, auth: 'login' as const }], modelPinned: true } };
    // Templates use a provider ID; no live config is consulted for historical defaults.
    saved.team.members = saved.team.members.map(m => ({ ...m, provider: 'openai' }));
    for (const [runId, workItemId] of [['a', 'item-a'], ['b', 'item-b']]) {
      f.store.record(task.id, 'run-started', { runId, workItemId, phase: 'implementation', agentId: members[0]!.id });
      f.store.record(task.id, 'run-completed', { runId, usage });
    }
    const result = taskUsage(saved, f.store.usageEvidence(task.id), f.service.config);
    assert.deepEqual(result.runs.map(r => r.attempt), [1, 1]);
    assert.ok(result.runs.every(r => r.priceBasis === 'reference' && r.estimatedUsd !== null && r.billing === 'unknown'));
    const unknown = taskUsage(task, f.store.usageEvidence(task.id), f.service.config);
    assert.ok(unknown.runs.every(r => r.model === null && r.estimatedUsd === null && r.billing === 'unknown'));
  } finally { await f.cleanup(); }
});
