import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
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
    // Unchanged credentials are not rewritten; changed credentials get a fresh envelope (new nonce).
    await f.vault.seal(); assert.equal(await readFile(f.vault.encrypted, 'utf8'), first);
    await writeFile(f.vault.auth, JSON.stringify({ tokens: { access_token: 'fixture-rotated' } }));
    await f.vault.seal(); assert.notEqual(await readFile(f.vault.encrypted, 'utf8'), first);
    await writeFile(f.vault.auth, plain); await f.vault.seal();
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

test('concurrent seals are serialized and the newest credential content wins', async () => {
  const f = await fixture();
  try {
    await f.vault.unlock(master); await mkdir(join(f.runtime, 'codex'), { recursive: true });
    await writeFile(f.vault.auth, plain);
    // Several workers finish together while the runtime rotates its token; no rename may interleave.
    const seals: Promise<void>[] = [];
    for (let i = 0; i < 5; i++) {
      seals.push(f.vault.seal());
      // Rotate atomically, as a well-behaved runtime does, so the test exercises seal ordering, not torn writes.
      await writeFile(`${f.vault.auth}.next`, JSON.stringify({ tokens: { access_token: `fixture-rotation-${i}` } })); await rename(`${f.vault.auth}.next`, f.vault.auth);
    }
    await Promise.all(seals);
    await f.vault.seal();
    await rm(f.runtime, { recursive: true }); await f.vault.unlock(master);
    assert.equal(await readFile(f.vault.auth, 'utf8'), JSON.stringify({ tokens: { access_token: 'fixture-rotation-4' } }));
  } finally { await f.cleanup(); }
});

test('a torn read of the runtime credential file is retried instead of failing the seal', async () => {
  const f = await fixture();
  try {
    await f.vault.unlock(master); await mkdir(join(f.runtime, 'codex'), { recursive: true });
    await writeFile(f.vault.auth, '{"tokens":{"access_token":"fixtu');
    setTimeout(() => { void writeFile(f.vault.auth, plain); }, 60);
    await f.vault.seal();
    await rm(f.runtime, { recursive: true }); await f.vault.unlock(master);
    assert.equal(await readFile(f.vault.auth, 'utf8'), plain);
  } finally { await f.cleanup(); }
});

test('seals through separate vault instances on the same files are serialized and keep the newest credentials', async () => {
  const f = await fixture();
  try {
    await f.vault.unlock(master); await mkdir(join(f.runtime, 'codex'), { recursive: true });
    await writeFile(f.vault.auth, plain);
    // Production creates a new CredentialVault per adapter call; every call must still take the same lock.
    const instances = Array.from({ length: 4 }, () => new CredentialVault(f.data, f.runtime));
    let active = 0; let maxActive = 0;
    for (const instance of instances) {
      const original = (instance as unknown as { sealNow(): Promise<void> }).sealNow.bind(instance);
      (instance as unknown as { sealNow(): Promise<void> }).sealNow = async () => { active++; maxActive = Math.max(maxActive, active); try { await new Promise(r => setTimeout(r, 15)); await original(); } finally { active--; } };
    }
    const seals: Promise<void>[] = [];
    for (const [i, instance] of instances.entries()) {
      seals.push(instance.seal());
      await writeFile(`${f.vault.auth}.next`, JSON.stringify({ tokens: { access_token: `fixture-instance-${i}` } })); await rename(`${f.vault.auth}.next`, f.vault.auth);
    }
    await Promise.all(seals);
    assert.equal(maxActive, 1, 'never more than one seal in flight across instances');
    await new CredentialVault(f.data, f.runtime).seal();
    await rm(f.runtime, { recursive: true }); await f.vault.unlock(master);
    assert.equal(await readFile(f.vault.auth, 'utf8'), JSON.stringify({ tokens: { access_token: 'fixture-instance-3' } }));
  } finally { await f.cleanup(); }
});
