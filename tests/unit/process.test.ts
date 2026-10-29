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
