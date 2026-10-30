import { createInterface } from 'node:readline';
import { Writable, type Readable } from 'node:stream';
import { AppError } from '../domain/errors.js';

/** Readline handles paste, editing and Ctrl+C; its terminal output is never echoed. */
export function readHiddenKey(
  input: Readable & { isTTY?: boolean } = process.stdin,
  output: Writable = process.stderr,
): Promise<string> {
  if (!input.isTTY) throw new AppError('terminal_required', 'API-key setup needs an interactive terminal. Run ./devagents start in your terminal.');
  output.write('Paste your OpenAI API key (input hidden; Ctrl+C cancels): ');
  const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const reader = createInterface({ input, output: muted, terminal: true, historySize: 0 });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (key?: string) => {
      if (settled) return; settled = true;
      input.removeListener('end', cancel); input.removeListener('close', cancel); input.removeListener('error', cancel);
      reader.close(); output.write('\n');
      if (key === undefined) reject(new AppError('cancelled', 'API-key setup cancelled; saved credentials were not changed'));
      else if (!key.trim() || /\s/.test(key.trim())) reject(new AppError('invalid_key', 'Paste one non-empty API key without whitespace'));
      else resolve(key.trim());
    };
    const cancel = () => finish();
    // Reject a partial paste if the terminal disconnects; readline would otherwise
    // emit its unfinished buffer as a submitted line on end-of-input.
    input.prependOnceListener('end', cancel);
    input.once('close', cancel); input.once('error', cancel);
    reader.once('line', key => finish(key));
    reader.once('SIGINT', () => finish());
    reader.once('close', () => finish());
    reader.once('error', () => finish());
  });
}
