import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupCodexAuth } from '../dist/engines/codex/setup.js';

// This tests local credential storage only; the fake key never makes a model request.
const root = await mkdtemp(join(tmpdir(), 'devagents-auth-'));
try {
  let prompts = 0;
  const readKey = async () => { prompts++; return 'sk-fixture-not-a-real-key'; };
  assert.equal(await setupCodexAuth(root, { store: 'file', readKey }), 'saved');
  assert.equal(await setupCodexAuth(root, { store: 'file', readKey }), 'reused');
  assert.equal(prompts, 1);
  assert.equal((await stat(join(root, 'engines', 'codex', 'auth.json'))).mode & 0o777, 0o600);
  console.log('PASS: real Codex saves credentials privately and subsequent setup skips the prompt.');
} finally { await rm(root, { recursive: true, force: true }); }
