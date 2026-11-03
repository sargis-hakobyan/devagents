import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { git } from '../../src/workspace/git.js';
import { originalCheckoutStatus, ORIGINAL_STATUS_TIMEOUT_MS } from '../../src/workspace/status.js';
import { AppError } from '../../src/domain/errors.js';
import { fixture } from '../helpers.js';

async function shim(body: string, run: (cwd: string, count: () => Promise<number>) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'devagents-git-scan-')); const oldPath = process.env.PATH;
  const log = join(dir, 'calls.json');
  await writeFile(join(dir, 'git'), `#!${process.execPath}
if(process.argv.includes('--fixture-ready'))process.exit(0);
const fs=require('node:fs');const log=${JSON.stringify(log)};
const calls=fs.existsSync(log)?JSON.parse(fs.readFileSync(log,'utf8')):[];
calls.push({args:process.argv.slice(2),optionalLocks:process.env.GIT_OPTIONAL_LOCKS});fs.writeFileSync(log,JSON.stringify(calls));
${body}
`, { mode: 0o700 });
  // Let the OS finish first-launch checks before measuring deliberately short process deadlines.
  await promisify(execFile)(join(dir, 'git'), ['--fixture-ready'], { timeout: 10000 });
  process.env.PATH = `${dir}:${oldPath ?? ''}`;
  try { await run(dir, async () => JSON.parse(await readFile(log, 'utf8')).length); }
  finally { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; await rm(dir, { recursive: true, force: true }); }
}

test('a slow original checkout scan retries once and retains full status checks without optional index writes', async () => {
  assert.equal(ORIGINAL_STATUS_TIMEOUT_MS, 120000);
  await shim("if(calls.length===1)setInterval(()=>{},1000);else process.stdout.write('?? new-file.txt\\n');", async (cwd, count) => {
    const retries: string[] = [];
    assert.equal(await originalCheckoutStatus(cwd, { timeoutMs: 1500, onRetry: message => retries.push(message) }), '?? new-file.txt');
    assert.equal(await count(), 2); assert.equal(retries.length, 1); assert.match(retries[0]!, /retrying once/);
    const calls = JSON.parse(await readFile(join(cwd, 'calls.json'), 'utf8'));
    for (const call of calls) { assert.deepEqual(call.args.slice(-3), ['status', '--porcelain=v1', '--untracked-files=all']); assert.equal(call.optionalLocks, '0'); }
  });
});

test('persistent scan timeouts produce an actionable error after exactly two attempts', async () => {
  await shim('setInterval(()=>{},1000);', async (cwd, count) => {
    await assert.rejects(originalCheckoutStatus(cwd, { timeoutMs: 1500 }), error => {
      assert.ok(error instanceof AppError); assert.equal(error.code, 'git_timeout');
      assert.match(error.message, /timed out after 2 attempts \(1.5 seconds each\)/);
      assert.match(error.message, /checkout check was not bypassed/); assert.doesNotMatch(error.message, /core.hooksPath/); return true;
    });
    assert.equal(await count(), 2);
  });
});

test('Git errors and oversized output are not retried or misreported as timeouts', async () => {
  await shim("console.error('fatal: not a git repository');process.exit(128);", async (cwd, count) => {
    await assert.rejects(originalCheckoutStatus(cwd), error => { assert.equal((error as { code: number }).code, 128); assert.match((error as Error).message, /not a git repository/); return true; });
    assert.equal(await count(), 1);
  });
  await shim("process.stdout.write('x'.repeat(3*1024*1024));", async (cwd, count) => {
    await assert.rejects(originalCheckoutStatus(cwd), (error: unknown) => error instanceof AppError && error.code === 'git_output_limit');
    assert.equal(await count(), 1);
  });
});

test('scan cancellation kills a running Git call and never retries', async () => {
  await shim('setInterval(()=>{},1000);', async (cwd, count) => {
    const controller = new AbortController();
    const promise = originalCheckoutStatus(cwd, { signal: controller.signal });
    const rejection = assert.rejects(promise, (error: unknown) => error instanceof AppError && error.code === 'cancelled');
    const deadline = Date.now() + 5000;
    try {
      while (await count().catch(() => 0) === 0) {
        if (Date.now() > deadline) throw new Error('Git fixture did not start');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    } finally { controller.abort(); }
    await rejection;
    assert.equal(await count(), 1);
    await assert.rejects(originalCheckoutStatus(cwd, { signal: controller.signal }), (error: unknown) => error instanceof AppError && error.code === 'cancelled');
    assert.equal(await count(), 1);
  });
});

test('non-scan Git timeouts have a clear reason and are not automatically retried', async () => {
  await shim('setInterval(()=>{},1000);', async (cwd, count) => {
    await assert.rejects(git(cwd, ['rev-parse', 'HEAD'], true, 1024, { timeoutMs: 1500 }), (error: unknown) => error instanceof AppError && error.code === 'git_timeout' && /Git rev-parse timed out after 1.5 seconds/.test(error.message));
    assert.equal(await count(), 1);
  });
});

test('original checkout scan still detects tracked and untracked source changes', async () => {
  const f = await fixture();
  try {
    assert.equal(await originalCheckoutStatus(f.project), '');
    await writeFile(join(f.project, 'README.md'), 'User edits\n');
    await writeFile(join(f.project, 'new-file.txt'), 'Untracked user work\n');
    const status = await originalCheckoutStatus(f.project);
    assert.match(status, /M README.md/); assert.match(status, /\?\? new-file.txt/);
    assert.equal(await readFile(join(f.project, 'README.md'), 'utf8'), 'User edits\n');
  } finally { await f.cleanup(); }
});
