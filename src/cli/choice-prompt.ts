import { createInterface, emitKeypressEvents } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { AppError } from '../domain/errors.js';

export type ChoiceOption<T extends string = string> = { value: T; label: string };
type TerminalInput = Readable & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (raw: boolean) => unknown };
type TerminalOutput = Writable & { isTTY?: boolean; columns?: number };

/** Discrete choices share arrow navigation; free text and secrets use their own prompts. */
export function selectChoice<T extends string>(question: string, choices: readonly ChoiceOption<T>[], defaultValue: T, input: TerminalInput = process.stdin, output: TerminalOutput = process.stderr): Promise<T> {
  if (!input.isTTY) throw new AppError('terminal_required', 'Run ./devagents setup in an interactive terminal.');
  let selected = choices.findIndex(c => c.value === defaultValue);
  if (selected < 0 || choices.length > 9) throw new Error('Invalid menu choices or default');
  if (!input.setRawMode || output.isTTY === false || process.env.TERM === 'dumb') {
    return (async () => {
      output.write(`\n${question}\n${choices.map((c, i) => `${i + 1}. ${c.label}`).join('\n')}\n`);
      for (;;) {
        const answer = await readChoice(`Choose [1-${choices.length}, Enter = ${selected + 1}]: `, input, output);
        if (!answer) return defaultValue;
        if (/^[1-9]$/.test(answer) && choices[Number(answer) - 1]) return choices[Number(answer) - 1]!.value;
        output.write('Choose one of the displayed numbers.\n');
      }
    })();
  }
  return new Promise((resolve, reject) => {
    const wasRaw = Boolean(input.isRaw); const wasFlowing = input.readableFlowing === true; let settled = false;
    const render = () => {
      const width = Math.max(12, (output.columns ?? 80) - 7);
      for (const [i, choice] of choices.entries()) {
        const label = Array.from(choice.label);
        output.write(`\r\x1b[2K${i === selected ? '>' : ' '} ${i + 1}. ${label.length > width ? label.slice(0, width - 1).join('') + '…' : choice.label}\n`);
      }
    };
    const finish = (value?: T) => {
      if (settled) return; settled = true;
      input.removeListener('keypress', keypress); input.removeListener('end', cancel); input.removeListener('close', cancel); input.removeListener('error', cancel);
      process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
      input.setRawMode!(wasRaw); if (!wasFlowing) input.pause();
      if (value === undefined) reject(new AppError('cancelled', 'Setup cancelled. Run ./devagents setup to continue.'));
      else resolve(value);
    };
    const cancel = () => finish();
    const keypress = (_text: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && ['c', 'd'].includes(key.name ?? '')) return cancel();
      if (key.name === 'return' || key.name === 'enter') return finish(choices[selected]!.value);
      if (key.name === 'up') selected = (selected + choices.length - 1) % choices.length;
      else if (key.name === 'down') selected = (selected + 1) % choices.length;
      else if (/^[1-9]$/.test(key.name ?? '') && choices[Number(key.name) - 1]) selected = Number(key.name) - 1;
      else return;
      output.write(`\x1b[${choices.length}A`); render();
    };
    emitKeypressEvents(input); input.on('keypress', keypress);
    input.once('end', cancel); input.once('close', cancel); input.once('error', cancel);
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    input.setRawMode!(true); input.resume();
    output.write(`\n${question}\nUse ↑/↓ or a number, then Enter. Ctrl+C cancels.\n`); render();
  });
}

export function readChoice(question: string, input: Readable & { isTTY?: boolean } = process.stdin, output: Writable = process.stderr): Promise<string> {
  if (!input.isTTY) throw new AppError('terminal_required', 'Run ./devagents start in an interactive terminal to choose a sign-in method.');
  const reader = createInterface({ input, output, terminal: true, historySize: 0 });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (answer?: string) => {
      if (settled) return; settled = true;
      input.removeListener('end', cancel); input.removeListener('close', cancel); input.removeListener('error', cancel);
      reader.close();
      if (answer === undefined) reject(new AppError('cancelled', 'Setup cancelled. Run ./devagents start to continue.'));
      else resolve(answer.trim());
    };
    const cancel = () => finish();
    input.prependOnceListener('end', cancel); input.once('close', cancel); input.once('error', cancel);
    reader.once('SIGINT', cancel); reader.once('close', cancel); reader.once('error', cancel);
    reader.question(question, finish);
  });
}
