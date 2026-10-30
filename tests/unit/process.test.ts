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

const marker = /\n…\[(\d+) bytes truncated\]…\n/;
const budgeted = (code: string, maxBytes = 1000) => runProcess(process.execPath, ['-e', code], { cwd: process.cwd(), env: { PATH: process.env.PATH }, timeoutMs: 10000, maxBytes, overflow: 'truncate' });
/** Retained bytes plus the reported drop must equal what the process wrote. */
function accounted(text: string, written: number, label: string): void {
  const m = marker.exec(text);
  const retained = Buffer.byteLength(text) - (m ? Buffer.byteLength(m[0]) : 0);
  assert.equal(retained + Number(m?.[1] ?? 0), written, `${label}: retained ${retained} + dropped ${m?.[1] ?? 0} must equal ${written}`);
}
test('output below or at the budget is kept whole and never reported as truncated', async () => {
  for (const n of [0, 1, 600, 999, 1000]) {
    const r = await budgeted(`process.stdout.write('x'.repeat(${n}))`);
    assert.equal(r.truncated, false, `${n} bytes`); assert.equal(r.stdout, 'x'.repeat(n), `${n} bytes`); assert.equal(r.exitCode, 0);
  }
});
test('output above the budget keeps a head and a tail and reports the discarded bytes exactly', async () => {
  for (const n of [1001, 1500, 5000, 300000]) {
    const r = await budgeted(`process.stdout.write('H' + 'x'.repeat(${n} - 2) + 'T')`);
    assert.equal(r.truncated, true, `${n} bytes`); accounted(r.stdout, n, `${n} bytes`);
    assert.ok(r.stdout.startsWith('H'), `${n}: head preserved`); assert.ok(r.stdout.endsWith('T'), `${n}: tail preserved`);
    assert.ok(Buffer.byteLength(r.stdout) <= 1000, `${n}: retained evidence stays within the budget`);
  }
});
test('the budget covers stdout and stderr together', async () => {
  const under = await budgeted("process.stdout.write('o'.repeat(400)); process.stderr.write('e'.repeat(400))");
  assert.equal(under.truncated, false); assert.equal(under.stdout, 'o'.repeat(400)); assert.equal(under.stderr, 'e'.repeat(400));
  const over = await budgeted("process.stdout.write('o'.repeat(600)); process.stderr.write('e'.repeat(600))");
  assert.equal(over.truncated, true);
  const retained = (t: string) => Buffer.byteLength(t) - (marker.exec(t) ? Buffer.byteLength(marker.exec(t)![0]) : 0);
  const dropped = (t: string) => Number(marker.exec(t)?.[1] ?? 0);
  assert.equal(retained(over.stdout) + dropped(over.stdout) + retained(over.stderr) + dropped(over.stderr), 1200);
  assert.ok(retained(over.stdout) + retained(over.stderr) <= 1000);
});
test('multi-byte and newline-free output is cut on code-point boundaries with exact accounting', async () => {
  const twoByte = await budgeted("process.stdout.write('é'.repeat(3000))");
  assert.equal(twoByte.truncated, true); assert.equal((twoByte.stdout.match(/\uFFFD/g) ?? []).length, 0); accounted(twoByte.stdout, 6000, 'two-byte');
  const fourByte = await budgeted("process.stdout.write('😀'.repeat(1000))");
  assert.equal(fourByte.truncated, true); assert.equal((fourByte.stdout.match(/\uFFFD/g) ?? []).length, 0); accounted(fourByte.stdout, 4000, 'four-byte');
  for (const ch of fourByte.stdout.replace(marker, '')) assert.equal(ch === '😀' || ch === '\n', true, 'no partial emoji survives a cut');
  const exact = await budgeted("process.stdout.write('é'.repeat(500))");
  assert.equal(exact.truncated, false); assert.equal(exact.stdout, 'é'.repeat(500));
});
