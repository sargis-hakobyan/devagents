import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, symlink, link, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexValidator } from '../../src/engines/codex/validator.js';
import { CODEX_VERSION } from '../../src/engines/codex/sandbox.js';

// Runs the real pinned Codex sandbox when it is installed; no credentials, model call or keyring access.
// Skipped elsewhere so `npm test` never requires the runtime.
const installed = await promisify(execFile)('codex', ['--version'], { timeout: 5000 }).then(r => r.stdout.trim() === `codex-cli ${CODEX_VERSION}`, () => false);

test('collapsed directory denials are enforced by the real sandbox and do not block sibling files', { skip: installed ? false : `Codex CLI ${CODEX_VERSION} is not installed` }, async () => {
  const base = await mkdtemp(join(tmpdir(), 'sandbox-containment-')); const root = join(base, 'project'); await mkdir(root);
  const outside = join(base, 'outside-secret'); await writeFile(outside, 'fake-service-secret');
  try {
    await writeFile(join(root, 'keep.txt'), 'ok');
    await mkdir(join(root, 'links')); for (const name of ['a', 'b']) await symlink(outside, join(root, 'links', name));
    await mkdir(join(root, 'mixed')); await symlink(outside, join(root, 'mixed', 'link')); await writeFile(join(root, 'mixed', 'real.txt'), 'ok');
    await mkdir(join(root, 'hard')); await writeFile(join(root, 'hard', 'a.txt'), 'x'); await link(join(root, 'hard', 'a.txt'), join(root, 'hard', 'b.txt'));
    await writeFile(join(root, 'probe.test.cjs'), `const fs = require('node:fs'); const test = require('node:test'); const assert = require('node:assert/strict');
test('containment', () => {
  assert.equal(fs.readFileSync('keep.txt', 'utf8'), 'ok');
  assert.equal(fs.readFileSync('mixed/real.txt', 'utf8'), 'ok');
  assert.throws(() => fs.readFileSync('mixed/link'), 'symlink inside a mixed directory');
  assert.throws(() => fs.readdirSync('links'), 'collapsed symlink directory listing');
  assert.throws(() => fs.readFileSync('links/a'), 'symlink through a collapsed directory');
  assert.throws(() => fs.readdirSync('hard'), 'collapsed hardlink directory listing');
  assert.throws(() => fs.readFileSync('hard/b.txt'), 'hardlink through a collapsed directory');
  assert.throws(() => fs.readFileSync(${JSON.stringify(outside)}), 'direct outside read');
  assert.throws(() => fs.writeFileSync('keep.txt', 'changed'), 'validation worktree is read-only');
});

`);
    const result = await new CodexValidator(join(base, 'data')).execute(root, { executable: 'node', args: ['--test', 'probe.test.cjs'] }, new AbortController().signal, 60000);
    assert.equal(result.exitCode, 0, result.output);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('engine policy permits internal package links and build output but still denies secrets and outside paths', { skip: installed ? false : `Codex CLI ${CODEX_VERSION} is not installed` }, async () => {
  const base = await mkdtemp(join(tmpdir(), 'sandbox-engine-policy-')); const root = join(base, 'project'); await mkdir(root);
  try {
    const outside = join(base, 'outside'); await writeFile(outside, 'synthetic-secret');
    await writeFile(join(root, '.env'), 'synthetic-secret'); await mkdir(join(root, '.git'));
    await mkdir(join(root, 'bin')); await writeFile(join(root, 'tool.cjs'), 'module.exports = 42;');
    await symlink('../tool.cjs', join(root, 'bin/tool')); await symlink(outside, join(root, 'bin/escape'));
    await symlink('../.env', join(root, 'bin/secret'));
    const script = `const fs=require('node:fs'),assert=require('node:assert/strict');
      assert.equal(require('./bin/tool'),42); fs.mkdirSync('dist'); fs.writeFileSync('dist/result','ok');
      for(const p of ['.env','bin/secret','bin/escape',${JSON.stringify(outside)}]) assert.throws(()=>fs.readFileSync(p));
      assert.throws(()=>fs.writeFileSync('.git/config','bad')); assert.throws(()=>fs.writeFileSync(${JSON.stringify(outside)},'bad'));
      assert.equal(process.env.CODEX_API_KEY,undefined);`;
    const validator = new CodexValidator(join(base, 'data'));
    const result = await validator.execute(root, { executable: 'node', args: ['-e', script] }, new AbortController().signal, 30000, false);
    assert.equal(result.exitCode, 0, result.output);
    await writeFile(join(root, 'strict.test.cjs'), "const fs=require('node:fs'),assert=require('node:assert/strict');assert.throws(()=>fs.writeFileSync('dist/result','changed'));");
    const strict = await validator.execute(root, { executable: 'node', args: ['--test', 'strict.test.cjs'] }, new AbortController().signal, 30000, true);
    assert.equal(strict.exitCode, 0, strict.output);
  } finally { await rm(base, { recursive: true, force: true }); }
});
