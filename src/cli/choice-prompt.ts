import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { AppError } from '../domain/errors.js';

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
