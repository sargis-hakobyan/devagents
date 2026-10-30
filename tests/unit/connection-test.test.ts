import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testCodexConnection, connectionFailure } from '../../src/engines/codex/connection-test.js';
import { AppError } from '../../src/domain/errors.js';

test('connection probe sends no project content, disallows commands/writes, bounds time, and cleans up', async () => {
  const data = await mkdtemp(join(tmpdir(), 'probe-test-')); let cwd = ''; let calls = 0;
  try {
    const result = await testCodexConnection(data, 'chatgpt', { engine: {
      id: 'codex', async preflight() {}, async execute(request) {
        calls++; cwd = request.cwd;
        assert.deepEqual(await readdir(cwd), []);
        assert.deepEqual(request.agent.permissions.writePaths, []);
        assert.equal(request.agent.permissions.allowCommands, false);
        assert.equal(request.provider.auth, 'login');
        assert.equal(request.provider.apiKeyEnv, undefined);
        assert.equal(request.timeoutMs, 45000);
        assert.equal(request.phase, 'review');
        return { output: { connected: true } };
      },
    } });
    assert.equal(result.ok, true); assert.equal(calls, 1);
    await assert.rejects(stat(cwd), { code: 'ENOENT' });
    const failed = await testCodexConnection(data, 'api-key', { engine: {
      id: 'codex', async preflight() {}, async execute() { return { output: { connected: false } }; },
    } });
    assert.equal(failed.ok, false);
  } finally { await rm(data, { recursive: true, force: true }); }
});
test('connection failures use safe, authentication-specific guidance and never raw runtime errors', () => {
  const secret = 'sk-private-test-key';
  assert.match(connectionFailure(new Error(`Quota exceeded ${secret}`), 'chatgpt'), /ChatGPT\/Codex allowance/);
  assert.match(connectionFailure(new Error(`Quota exceeded ${secret}`), 'api-key'), /API credits/);
  for (const [code, message, expected] of [
    ['engine_failed', '401 unauthorized', /sign in again/],
    ['engine_failed', '429 rate limit', /rate-limiting/],
    ['timeout', 'deadline', /internet connection/],
    ['cancelled', 'abort', /cancelled/],
    ['engine_version', 'old', /incompatible/],
    ['engine_failed', 'model_not_found', /model is unavailable/],
    ['unknown', 'unexpected', /not confirmed/],
  ] as const) {
    const text = connectionFailure(new AppError(code, `${message} ${secret}`), 'chatgpt');
    assert.match(text, expected); assert.ok(!text.includes(secret));
  }
});
