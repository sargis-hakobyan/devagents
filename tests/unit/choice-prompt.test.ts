import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readChoice } from '../../src/cli/choice-prompt.js';

test('choice prompt accepts a submitted choice and restores terminal mode', async () => {
  let raw = false;
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode(value: boolean) { raw = value; } });
  const result = readChoice('Choose: ', input, new PassThrough()); input.write('1\r');
  assert.equal(await result, '1'); assert.equal(raw, false);
});
test('choice prompt refuses non-TTY and cancels Ctrl+C or partial disconnected input', async () => {
  assert.throws(() => readChoice('Choose: ', new PassThrough()), /interactive terminal/);
  for (const end of ['SIGINT', 'end']) {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
    const result = readChoice('Choose: ', input, new PassThrough()); input.write('1');
    if (end === 'SIGINT') input.write('\x03'); else input.emit('end');
    await assert.rejects(result, /cancelled/);
  }
});
