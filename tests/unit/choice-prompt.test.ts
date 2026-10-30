import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readChoice, selectChoice } from '../../src/cli/choice-prompt.js';

const choices = [{ value: 'chatgpt', label: 'ChatGPT' }, { value: 'key', label: 'API key' }, { value: 'saved', label: 'Saved login' }];
test('selection menus navigate arrows and numbers, respect safe defaults, and restore raw mode', async () => {
  const term = process.env.TERM; process.env.TERM = 'xterm';
  try {
    for (const [keys, expected] of [['\r', 'saved'], ['\x1b[A\r', 'key'], ['\x1b[B\r', 'chatgpt'], ['1\r', 'chatgpt'], ['x9\x1b[A\x1b[B\r', 'saved']]) {
      let raw = false;
      const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode(value: boolean) { raw = value; } });
      const output = Object.assign(new PassThrough(), { isTTY: true, columns: 40 });
      const result = selectChoice('Connect?', choices, 'saved', input, output);
      assert.equal(raw, true); input.write(keys!);
      assert.equal(await result, expected); assert.equal(raw, false); assert.equal(input.listenerCount('keypress'), 0);
    }
  } finally { if (term === undefined) delete process.env.TERM; else process.env.TERM = term; }
});
test('selection cancellation restores input on Ctrl+C, EOF, disconnect and process signals', async () => {
  const term = process.env.TERM; process.env.TERM = 'xterm';
  const interrupts = process.listenerCount('SIGINT'); const terminations = process.listenerCount('SIGTERM');
  try {
    assert.throws(() => selectChoice('Connect?', choices, 'saved', new PassThrough()), /interactive terminal/);
    for (const action of ['\x03', '\x04', 'end', 'SIGINT', 'SIGTERM']) {
      let raw = false;
      const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode(value: boolean) { raw = value; } });
      const result = selectChoice('Connect?', choices, 'saved', input, new PassThrough());
      if (action === 'end') input.emit('end'); else if (action.startsWith('SIG')) process.emit(action as 'SIGINT', 'SIGINT'); else input.write(action);
      await assert.rejects(result, /cancelled/); assert.equal(raw, false);
      assert.equal(process.listenerCount('SIGINT'), interrupts); assert.equal(process.listenerCount('SIGTERM'), terminations);
    }
  } finally { if (term === undefined) delete process.env.TERM; else process.env.TERM = term; }
});

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
