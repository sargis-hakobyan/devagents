import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeLimitations, describeLimitations, LimitationLedger, LIMITATION_LIMIT, LIMITATION_IDENTITY_LIMIT, normalizeLegacyLimitations } from '../../src/domain/limitations.js';
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
  assert.deepEqual(Plan.parse(plan).manualChecks, [], 'defaulted, never optional: strict model schemas require every property');
  assert.deepEqual(Plan.parse({ ...plan, manualChecks: ['Check the layout at 390 px'] }).manualChecks, ['Check the layout at 390 px']);
  assert.throws(() => Plan.parse({ ...plan, manualChecks: Array.from({ length: 11 }, () => 'x') }));
});
test('merging deduplicates case-insensitively, trims, and stays bounded', () => {
  assert.deepEqual(mergeLimitations(['No browser '], ['no browser', 'No network'], undefined, ['']).limitations, ['No browser', 'No network']);
  const bounded = mergeLimitations(Array.from({ length: 40 }, (_, i) => `check ${i}`));
  assert.equal(bounded.limitations.length, LIMITATION_LIMIT); assert.equal(bounded.limitationsOmitted, 20); assert.equal(bounded.limitationCount, 40);
  assert.equal(describeLimitations(mergeLimitations([])), ''); assert.equal(describeLimitations(mergeLimitations(['a'])), ' · 1 check not run in this environment'); assert.equal(describeLimitations(mergeLimitations(['a', 'b'])), ' · 2 checks not run in this environment');
});

test('the ledger keeps every attempt\'s reports, redacts like evidence, and discloses what its bounds dropped', () => {
  const ledger = new LimitationLedger(['configured-secret-value']);
  assert.deepEqual(ledger.add(['Cannot check service; password=SYNTHETIC_ONLY', 'Token configured-secret-value rejected', ' Cannot check service; password=SYNTHETIC_ONLY ']), ['Cannot check service; password=[REDACTED]', 'Token [REDACTED] rejected']);
  assert.deepEqual(ledger.add(['cannot check service; PASSWORD=SYNTHETIC_ONLY']), [], 'case-insensitive duplicates after redaction are not added twice');
  assert.deepEqual(ledger.list(), ['Cannot check service; password=[REDACTED]', 'Token [REDACTED] rejected']);
  ledger.add(Array.from({ length: 60 }, (_, i) => `report ${i}`));
  assert.equal(ledger.size, 62);
  const shown = ledger.list();
  assert.equal(shown.length, LIMITATION_LIMIT); assert.equal(ledger.snapshot().limitationsOmitted, 42);
  ledger.add(['REPORT 59', 'report 59']);
  assert.equal(ledger.size, 62, 'overflow identities still deduplicate');
  assert.equal(ledger.snapshot().limitationsOmitted, 42);
  assert.equal(describeLimitations(ledger.snapshot()), ' · 62 checks not run in this environment');
  assert.equal(new LimitationLedger().list().length, 0);
});

test('identity exhaustion is bounded and labelled as occurrences, never fabricated distinct checks', () => {
  const ledger = new LimitationLedger();
  ledger.add(Array.from({ length: LIMITATION_IDENTITY_LIMIT }, (_, i) => `report ${i}`));
  ledger.add(['later report', 'later report', 'REPORT 0']);
  assert.equal(ledger.size, LIMITATION_IDENTITY_LIMIT);
  assert.equal(ledger.snapshot().limitationOverflow, 2);
  assert.equal(ledger.snapshot().limitationsOmitted, LIMITATION_IDENTITY_LIMIT - LIMITATION_LIMIT);
  assert.match(describeLimitations(ledger.snapshot()), /at least 4096 checks/);
});
test('old notices are read as metadata while ordinary old tasks still load', () => {
  const old = { limitations: ['Browser absent', '2 further reported checks omitted from this list; the task evidence has every report'] };
  const normalized = normalizeLegacyLimitations(old);
  assert.deepEqual(normalized, { limitations: ['Browser absent'], limitationCount: 1, limitationsOmitted: 0, limitationOverflow: 2 });
  assert.deepEqual(normalizeLegacyLimitations({}), {});
});
