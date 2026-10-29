import test from 'node:test';
import assert from 'node:assert/strict';
import { redact, redactValues } from '../../src/telemetry/redact.js';

const code = [
  'const token: string = req.headers.authorization;',
  '  password: string;',
  '  apiKey = process.env.KEY;',
  'interface Session { token: string; secret?: Buffer }',
  'export const secret = loadSecret();',
].join('\n');

test('model-input redaction preserves code syntax and removes only known secret values and credential tokens', () => {
  assert.equal(redactValues(code, []), code);
  assert.equal(redactValues(`${code}\nconst key = 'fixture-secret-value';`, ['fixture-secret-value']), `${code}\nconst key = '[REDACTED]';`);
  assert.equal(redactValues('OPENAI_API_KEY=sk-proj-abcdefghijklmnop ghp_abcdefghijklmnop github_pat_abcdefghijkl', []), 'OPENAI_API_KEY=[REDACTED] [REDACTED] [REDACTED]');
  assert.deepEqual(redactValues({ token: 'token: string', nested: ['password = hunter2', 'fixture-secret-value'] }, ['fixture-secret-value']), { token: 'token: string', nested: ['password = hunter2', '[REDACTED]'] });
  // Short values are never used as patterns; keys that merely look sensitive are left alone.
  assert.equal(redactValues('abc', ['abc']), 'abc');
});
test('log and evidence redaction keeps the heuristic credential masking', () => {
  assert.equal(redact('password = hunter2; Authorization: Bearer abc.def', []), 'password = [REDACTED]; Authorization: Bearer [REDACTED]');
  assert.deepEqual(redact({ token: 'anything', input_tokens: 12, enabled: true, nested: ['fixture-secret-value'] }, ['fixture-secret-value']), { token: '[REDACTED]', input_tokens: 12, enabled: true, nested: ['[REDACTED]'] });
});
