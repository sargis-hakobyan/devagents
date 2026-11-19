import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { Store } from '../../src/persistence/store.js';
import { sharedVaultOwner, vaultMaterialExists, verifyVaultBinding } from '../../src/security/vault-owner.js';
import { CredentialVault } from '../../src/security/credential-vault.js';

const run = promisify(execFile);
test('KMS launcher reuses an owner-bound encrypted key and refuses to replace a missing or invalid key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devagents-kms-test-'));
  const store = await Store.open(join(root, 'devagents.db'), []);
  const runtime = join(root, 'runtime');
  const owner = randomUUID();
  const arn = 'arn:aws:kms:eu-central-1:000000000000:key/fixture';
  const master = Buffer.alloc(32, 19);
  try {
    await mkdir(runtime);
    await store.bindWorkspaceOwner(owner);
    assert.equal(await sharedVaultOwner(root), owner);
    const aws = join(root, 'aws');
    // The fixture models an opaque blob that KMS will unwrap only with the same key and context.
    await writeFile(aws, `#!/usr/bin/env python3
import base64,hashlib,os,sys
from pathlib import Path
a=sys.argv
bind=hashlib.sha256((a[a.index('--key-id')+1]+a[a.index('--encryption-context')+1]).encode()).digest()
if a[2]=='generate-data-key-without-plaintext':
 print(base64.b64encode(bind).decode())
elif a[2]=='decrypt' and Path(a[a.index('--ciphertext-blob')+1].removeprefix('fileb://')).read_bytes()==bind:
 print(base64.b64encode(bytes([19])*32).decode())
else: sys.exit(1)
`, { mode: 0o700 });
    const script = resolve('scripts/kms-vault-key.py');
    const key = async (existing: string, id = owner, keyArn = arn) =>
      (await run('python3', [script, keyArn, id, existing], { cwd: root, env: { PATH: root + ':' + process.env.PATH } })).stdout;
    await assert.rejects(key('yes'), /requires its original/);
    assert.equal(await key('no'), master.toString('hex'));
    const wrapped = join(root, '.devagents/kms', owner + '.wrapped');
    assert.notDeepEqual(await readFile(wrapped), master);
    await verifyVaultBinding(root, runtime, master.toString('hex'), owner);
    const vault = new CredentialVault(root, runtime, 'claude');
    await vault.unlock(master.toString('hex'));
    await mkdir(join(runtime, 'claude'), { recursive: true });
    await writeFile(vault.auth, JSON.stringify({ value: 'fixture-secret' }));
    await vault.seal();
    await rm(runtime, { recursive: true });
    await mkdir(runtime);
    const restored = await key('yes');
    await verifyVaultBinding(root, runtime, restored, owner);
    await vault.unlock(restored);
    assert.equal(JSON.parse(await readFile(vault.auth, 'utf8')).value, 'fixture-secret');
    await assert.rejects(verifyVaultBinding(root, runtime, restored), /KMS-protected/);
    await assert.rejects(verifyVaultBinding(root, runtime, '0'.repeat(64), owner), /original vault key/);
    await assert.rejects(verifyVaultBinding(root, runtime, restored, randomUUID()), /different workspace owner/);
    await assert.rejects(key('yes', owner, arn + '2'), /KMS decrypt failed/);
    await rm(wrapped);
    assert.ok(await vaultMaterialExists(root, runtime));
    await assert.rejects(key('yes'), /requires its original/);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});
