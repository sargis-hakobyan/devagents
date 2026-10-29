import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupCodexAuth } from '../../src/engines/codex/setup.js';

test('setup persists a stdin-only key privately, reuses it, and replaces it only when requested', async () => {
  const root = await mkdtemp(join(tmpdir(), 'auth-setup-'));
  const binary = join(root, 'codex'); const home = join(root, 'engines', 'codex'); const credential = join(home, 'auth.json');
  const shim = `#!${process.execPath}
import fs from 'node:fs';
const path=process.env.CODEX_HOME+'/auth.json';
if(process.argv.includes('status'))process.exit(fs.existsSync(path)?0:1);
if(!process.argv.includes('--with-api-key'))process.exit(2);
if(process.argv.some(a=>a.includes('fixture-key')))process.exit(3);
let key='';for await(const part of process.stdin)key+=part;
fs.writeFileSync(path, JSON.stringify({OPENAI_API_KEY:key.trim()}), {mode:0o644});
`;
  try {
    await writeFile(binary, shim, { mode: 0o700 });
    let prompts = 0;
    const readKey = async () => { prompts++; return 'fixture-key-first'; };
    assert.equal(await setupCodexAuth(root, { store: 'file', binary, readKey }), 'saved');
    assert.equal((await stat(credential)).mode & 0o777, 0o600);
    assert.equal((await stat(home)).mode & 0o777, 0o700);
    assert.equal(await setupCodexAuth(root, { store: 'file', binary, readKey }), 'reused');
    assert.equal(prompts, 1);
    await assert.rejects(setupCodexAuth(root, { store: 'file', binary, replaceKey: true, readKey: async () => { throw new Error('cancelled'); } }), /cancelled/);
    assert.equal(JSON.parse(await readFile(credential, 'utf8')).OPENAI_API_KEY, 'fixture-key-first');
    assert.equal(await setupCodexAuth(root, { store: 'file', binary, replaceKey: true, readKey: async () => 'fixture-key-second' }), 'saved');
    assert.equal(JSON.parse(await readFile(credential, 'utf8')).OPENAI_API_KEY, 'fixture-key-second');
    await writeFile(binary, `#!${process.execPath}\nconsole.error('fixture-key-do-not-print');process.exit(1);\n`, { mode: 0o700 });
    await assert.rejects(setupCodexAuth(root, { store: 'file', binary, replaceKey: true, readKey }), error => error instanceof Error && /could not save/.test(error.message) && !error.message.includes('fixture-key'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
