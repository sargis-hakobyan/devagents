import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CredentialVault } from '../../src/security/credential-vault.js';

const master = 'a'.repeat(64);
const plain = JSON.stringify({ OPENAI_API_KEY: 'sk-fixture-sensitive-value' });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'vault-test-'));
  const data = join(root, 'data'); const runtime = join(root, 'runtime');
  const vault = new CredentialVault(data, runtime);
  return { root, data, runtime, vault, cleanup: () => rm(root, { recursive: true, force: true }) };
}
test('vault encrypts persistently, uses unique nonces, and restores after runtime loss', async () => {
  const f = await fixture();
  try {
    await f.vault.unlock(master); await mkdir(join(f.runtime, 'codex'), { recursive: true });
    await writeFile(f.vault.auth, plain); await f.vault.seal();
    const first = await readFile(f.vault.encrypted, 'utf8');
    assert.equal(first.includes('sk-fixture-sensitive-value'), false); assert.equal(first.includes(master), false);
    assert.equal((await stat(f.vault.encrypted)).mode & 0o777, 0o600);
    await f.vault.seal(); assert.notEqual(await readFile(f.vault.encrypted, 'utf8'), first);
    await rm(f.runtime, { recursive: true }); await assert.rejects(f.vault.assertUnlocked(), /locked/);
    await f.vault.unlock(master); assert.equal(await readFile(f.vault.auth, 'utf8'), plain);
  } finally { await f.cleanup(); }
});
test('wrong keys and altered ciphertext fail closed without overwriting credentials', async () => {
  const f = await fixture();
  try {
    await f.vault.unlock(master); await mkdir(join(f.runtime, 'codex'), { recursive: true });
    await writeFile(f.vault.auth, plain); await f.vault.seal();
    const original = await readFile(f.vault.encrypted, 'utf8'); await rm(f.runtime, { recursive: true });
    await assert.rejects(f.vault.unlock('b'.repeat(64)), /could not be decrypted/);
    assert.equal(await readFile(f.vault.encrypted, 'utf8'), original);
    await assert.rejects(stat(f.vault.master), { code: 'ENOENT' });
    for (const field of ['nonce', 'tag', 'ciphertext']) {
      const envelope = JSON.parse(original); const bytes = Buffer.from(envelope[field], 'base64'); bytes[0] = bytes[0]! ^ 1;
      envelope[field] = bytes.toString('base64'); await writeFile(f.vault.encrypted, JSON.stringify(envelope));
      await assert.rejects(f.vault.unlock(master), /could not be decrypted/);
      await assert.rejects(stat(f.vault.auth), { code: 'ENOENT' });
    }
  } finally { await f.cleanup(); }
});
test('legacy credentials migrate only after encryption succeeds; refreshed runtime credentials survive repeated unlock', async () => {
  const f = await fixture(); const legacy = join(f.data, 'engines', 'codex', 'auth.json');
  try {
    await mkdir(join(f.data, 'engines', 'codex'), { recursive: true }); await writeFile(legacy, plain);
    await f.vault.unlock(master);
    await assert.rejects(stat(legacy), { code: 'ENOENT' });
    assert.equal(await readFile(f.vault.auth, 'utf8'), plain);
    const refreshed = JSON.stringify({ tokens: { access_token: 'fixture-refreshed' } });
    await writeFile(f.vault.auth, refreshed); await f.vault.unlock(master);
    await rm(f.runtime, { recursive: true }); await f.vault.unlock(master);
    assert.equal(await readFile(f.vault.auth, 'utf8'), refreshed);
    await writeFile(legacy, plain);
    await assert.rejects(f.vault.unlock(master), /different contents/);
    assert.equal(await readFile(legacy, 'utf8'), plain);
  } finally { await f.cleanup(); }
});
