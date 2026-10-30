import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loginWithChatGPT } from '../../src/engines/codex/device-login.js';

test('device login uses the dedicated profile and persists privately; failed login retains existing credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'device-login-')); const binary = join(root, 'codex');
  const credential = join(root, 'engines', 'codex', 'auth.json');
  try {
    await writeFile(binary, `#!${process.execPath}
import fs from 'node:fs';
if(!process.argv.includes('--device-auth') || process.argv.includes('--with-api-key'))process.exit(2);
fs.writeFileSync(process.env.CODEX_HOME+'/auth.json', JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'fake-token'}}),{mode:0o644});
`, { mode: 0o700 });
    await loginWithChatGPT(root, { binary, store: 'file' });
    assert.equal((await stat(credential)).mode & 0o777, 0o600);
    const before = await readFile(credential, 'utf8');
    await writeFile(binary, `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o700 });
    await assert.rejects(loginWithChatGPT(root, { binary, store: 'file' }), /Enable device code sign-in/);
    assert.equal(await readFile(credential, 'utf8'), before);
    await assert.rejects(loginWithChatGPT(root, { binary: join(root, 'missing'), store: 'file' }), /Could not start Codex/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('cancelled device login terminates the child and removes signal listeners', async () => {
  const root = await mkdtemp(join(tmpdir(), 'device-cancel-')); const binary = join(root, 'codex');
  const listeners = process.listenerCount('SIGINT');
  try {
    await writeFile(binary, `#!${process.execPath}\nsetInterval(()=>{},1000);\n`, { mode: 0o700 });
    const controller = new AbortController();
    const result = loginWithChatGPT(root, { binary, store: 'file', signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 100);
    try { await assert.rejects(result, /cancelled/); } finally { clearTimeout(timer); }
    assert.equal(process.listenerCount('SIGINT'), listeners);
  } finally { await rm(root, { recursive: true, force: true }); }
});
