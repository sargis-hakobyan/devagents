import test from 'node:test';
import assert from 'node:assert/strict';
import { runProcess } from '../../src/engines/process.js';

test('process execution bounds output, handles missing executables and terminates on timeout', async () => {
  const options = { cwd: process.cwd(), env: { PATH: process.env.PATH }, timeoutMs: 100 };
  await assert.rejects(runProcess('/missing/devagents-engine', [], options), /Unable to launch/);
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], options), /time limit/);
  await assert.rejects(runProcess(process.execPath, ['-e', 'console.log("x".repeat(2000))'], { ...options, timeoutMs: 2000, maxBytes: 100 }), /output exceeded/);
});
test('abort cancels a process and malformed streaming output cannot pass as success', async () => {
  const controller = new AbortController();
  const promise = runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: process.cwd(), env: {}, timeoutMs: 5000, signal: controller.signal });
  controller.abort(); await assert.rejects(promise, /cancelled/);
  await assert.rejects(runProcess(process.execPath, ['-e', 'console.log("bad-json")'], { cwd: process.cwd(), env: {}, timeoutMs: 5000, onLine: line => { JSON.parse(line); } }));
});

test('truncate mode keeps head and tail with a marker instead of killing the process', async () => {
  const result = await runProcess(process.execPath, ['-e', "process.stdout.write('HEAD-' + 'a'.repeat(200000) + '-TAIL\\n'); console.error('warn')"], { cwd: process.cwd(), env: { PATH: process.env.PATH }, timeoutMs: 5000, maxBytes: 100000, overflow: 'truncate' });
  assert.equal(result.exitCode, 0); assert.equal(result.truncated, true);
  assert.ok(result.stdout.startsWith('HEAD-')); assert.ok(result.stdout.trimEnd().endsWith('-TAIL'));
  assert.match(result.stdout, /…\[\d+ bytes truncated\]…/);
  assert.ok(Buffer.byteLength(result.stdout) < 100000); assert.equal(result.stderr, 'warn\n');
  const small = await runProcess(process.execPath, ['-e', "console.log('ok')"], { cwd: process.cwd(), env: { PATH: process.env.PATH }, timeoutMs: 5000, maxBytes: 100000, overflow: 'truncate' });
  assert.equal(small.truncated, false); assert.equal(small.stdout, 'ok\n');
});
