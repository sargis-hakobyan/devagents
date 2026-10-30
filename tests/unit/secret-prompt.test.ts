import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { readHiddenKey } from '../../src/cli/secret-prompt.js';

function terminal() {
  let output = ''; let raw = false;
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode(value: boolean) { raw = value; } });
  const sink = new Writable({ write(chunk, _encoding, callback) { output += String(chunk); callback(); } });
  return { input, sink, output: () => output, raw: () => raw };
}
test('API key paste is hidden and terminal mode is restored', async () => {
  const t = terminal(); const key = readHiddenKey(t.input, t.sink);
  t.input.write('fixture-secret-123456\r');
  assert.equal(await key, 'fixture-secret-123456');
  assert.equal(t.output().includes('fixture-secret'), false);
  assert.equal(t.raw(), false);
});
test('Ctrl+C and end-of-input cancel without leaking input or leaving raw mode enabled', async () => {
  for (const end of ['ctrl-c', 'eof']) {
    const t = terminal(); const key = readHiddenKey(t.input, t.sink);
    t.input.write('fixture-secret');
    if (end === 'ctrl-c') t.input.write('\x03'); else t.input.destroy();
    // A normal terminal EOF is Ctrl+D on an empty line.
    if (end === 'eof') t.input.emit('end');
    await assert.rejects(key, /cancelled/);
    assert.equal(t.output().includes('fixture-secret'), false); assert.equal(t.raw(), false);
  }
});
test('noninteractive input is refused before consuming a secret', async () => {
  assert.throws(() => readHiddenKey(new PassThrough()), /interactive terminal/);
});
