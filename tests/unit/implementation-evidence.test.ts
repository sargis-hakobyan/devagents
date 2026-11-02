import test from 'node:test';
import assert from 'node:assert/strict';
import { ImplementationEvidence } from '../../src/orchestration/implementation-evidence.js';

test('implementation command handoff bounds output, retains failure statuses, and redacts before previewing', () => {
  const evidence = new ImplementationEvidence(['private-fixture-value']);
  for (let i = 0; i < 22; i++) evidence.observe({ kind: 'command', data: {
    command: `command-${i} private-fixture-value`, exit_code: i === 21 ? 1 : 0,
    aggregated_output: 'x'.repeat(1990) + 'private-fixture-value' + 'x'.repeat(10000) + 'completion summary',
  } });
  const rendered = evidence.render({ summary: 'private-fixture-value claimed success' });
  assert.doesNotMatch(rendered, /private-fixture/);
  assert.match(rendered, /"omittedCommands":2/); assert.match(rendered, /"exitCode":1/);
  assert.match(rendered, /completion summary/); assert.match(rendered, /untrusted claim/);
  assert.ok(rendered.length < 130000);
  assert.doesNotMatch(rendered, /command-0 /);
});

test('the immediate report handoff redacts prose without rewriting command code', () => {
  const evidence = new ImplementationEvidence([]);
  evidence.observe({ kind: 'command', data: { command: 'const token: string = session.token;', aggregated_output: 'ok', exit_code: 0 } });
  const rendered = evidence.render({ summary: 'Service password=SYNTHETIC_SUMMARY', limitations: ['Browser token: SYNTHETIC_REPORT'] });
  assert.doesNotMatch(rendered, /SYNTHETIC_SUMMARY|SYNTHETIC_REPORT/);
  assert.match(rendered, /const token: string = session.token/);
});
