import assert from 'node:assert/strict';
import { readFile, stat, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuredVault } from '../dist/security/credential-vault.js';
import { setupCodexAuth } from '../dist/engines/codex/setup.js';
import { CodexValidator } from '../dist/engines/codex/validator.js';
const data = process.env.DEVAGENTS_DATA_DIR;
const vault = await configuredVault(data);
assert.ok(vault, 'Expected a verified tmpfs credential runtime');
if (process.argv[2] === 'create') {
  await vault.unlock('3'.repeat(64));
  assert.equal(await setupCodexAuth(data, { readKey: async () => 'sk-fixture-encrypted-not-real' }), 'saved');
  const encrypted = await readFile(vault.encrypted, 'utf8');
  assert.equal(encrypted.includes('sk-fixture-encrypted-not-real'), false);
  await assert.rejects(stat(`${data}/engines/codex/auth.json`), { code: 'ENOENT' });
  const project = await mkdtemp(join(tmpdir(), 'vault-boundary-'));
  try {
    await writeFile(join(project, 'credential.test.cjs'), `const fs=require('node:fs'),assert=require('node:assert/strict'),test=require('node:test');test('runtime credentials are inaccessible',()=>{for(const path of ${JSON.stringify([vault.auth, vault.master, vault.encrypted])})assert.throws(()=>fs.readFileSync(path));});`);
    const result = await new CodexValidator(data).execute(project, { executable: 'node', args: ['--test', 'credential.test.cjs'] }, new AbortController().signal, 15000);
    assert.equal(result.exitCode, 0, result.output);
  } finally { await rm(project, { recursive: true, force: true }); }
  console.log('PASS: Docker stores encrypted credentials and keeps plaintext on tmpfs only.');
} else {
  await assert.rejects(vault.assertUnlocked(), /locked/);
  await vault.unlock('3'.repeat(64));
  assert.equal(await setupCodexAuth(data, { readKey: async () => { throw new Error('Unexpected key prompt'); } }), 'reused');
  console.log('PASS: restart clears the decrypted runtime; unlocking restores saved credentials without prompting.');
}
