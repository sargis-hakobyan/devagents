import test from 'node:test';
import assert from 'node:assert/strict';
import { PolicyEngine } from '../../src/domain/policy.js';
import { redact } from '../../src/telemetry/redact.js';
import { Config } from '../../src/domain/schemas.js';
import { fixture } from '../helpers.js';

test('reviewer cannot write; secret access, arbitrary commands and external effects fail closed', async () => {
  const f = await fixture();
  try {
    const policy = new PolicyEngine(); const agents = await f.service.agents();
    const reviewer = agents.find(a => a.id === 'code-reviewer')!;
    await policy.file(reviewer, f.project, 'README.md', 'read');
    await assert.rejects(policy.file(reviewer, f.project, 'README.md', 'write'), /cannot write/);
    await assert.rejects(policy.file(reviewer, f.project, '.env', 'read'), /Secret/);
    assert.throws(() => policy.command(), /verified execution sandbox/);
    for (const action of ['push', 'merge', 'deploy'] as const) assert.throws(() => policy.external(action), /not enabled/);
  } finally { await f.cleanup(); }
});
test('secrets are recursively redacted and model/provider IDs remain extensible', () => {
  assert.deepEqual(redact({ token: 'hidden', nested: ['Bearer abc', 'sk-proj-abcdefghijk', 'custom-secret'] }, ['custom-secret']), { token: '[REDACTED]', nested: ['Bearer [REDACTED]', '[REDACTED]', '[REDACTED]'] });
  const config = Config.parse({ schemaVersion: 1, defaultProvider: 'local', providers: [{ id: 'local', kind: 'ollama', auth: 'none', baseUrl: 'http://localhost:11434' }] });
  assert.equal(config.providers[0]!.id, 'local');
  assert.throws(() => Config.parse({ schemaVersion: 1, providers: [{ id: 'openai', kind: 'openai', auth: 'api-key', apiKey: 'inline-secret' }] }));
});
