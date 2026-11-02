import test from 'node:test';
import assert from 'node:assert/strict';
import { validationEvidence } from '../../src/orchestration/validation-evidence.js';

test('verbose earlier checks do not hide later results or completion summaries from review', () => {
  const results = [
    { executable: 'npm', args: ['test'], exitCode: 0, truncated: false, output: 'start\n' + 'details\n'.repeat(15000) + '400 tests passed' },
    { executable: 'npm', args: ['run', 'typecheck'], exitCode: 0, output: 'Types passed' },
    { executable: 'npm', args: ['run', 'lint'], exitCode: 1, truncated: true, output: 'Lint failed' },
  ];
  const data = JSON.parse(validationEvidence(results));
  assert.equal(data.length, 3);
  assert.match(data[0].output, /^start/); assert.match(data[0].output, /400 tests passed$/);
  assert.equal(data[0].outputPreview, true); assert.equal(data[0].truncated, false);
  assert.equal(data[1].output, 'Types passed'); assert.equal(data[1].exitCode, 0);
  assert.equal(data[2].exitCode, 1); assert.equal(data[2].truncated, true);
  assert.ok(data[0].output.length < 14000);
});

test('validation previews redact credential values before cutting output boundaries', () => {
  const secret = 'synthetic-credential-with-a-recognizable-prefix';
  const output = 'a'.repeat(13325) + secret + 'b'.repeat(45000) + secret + 'c'.repeat(26660);
  const preview = validationEvidence([{ executable: 'fixture', args: [secret], exitCode: 0, output }], [secret]);
  assert.doesNotMatch(preview, /synthetic|recognizable-prefix/);
  assert.equal(JSON.parse(preview)[0].args[0], '[REDACTED]');
});
