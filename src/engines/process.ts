import { spawn } from 'node:child_process';
import { AppError } from '../domain/errors.js';

export type ProcessOptions = {
  cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs: number;
  input?: string; onLine?: (line: string) => void; maxBytes?: number;
  /** 'fail' (default) terminates the process when output exceeds maxBytes; 'truncate' keeps head and tail and marks the result. */
  overflow?: 'fail' | 'truncate';
};
export type ProcessResult = { stdout: string; stderr: string; exitCode: number; truncated: boolean };
/** Cut a string at a byte budget without splitting a UTF-8 code point. */
function firstBytes(text: string, limit: number): string {
  const bytes = Buffer.from(text, 'utf8'); if (bytes.length <= limit) return text;
  let cut = limit; while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut--;
  return bytes.subarray(0, cut).toString('utf8');
}
function lastBytes(text: string, limit: number): string {
  const bytes = Buffer.from(text, 'utf8'); if (bytes.length <= limit) return text;
  let start = bytes.length - limit; while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
}
/**
 * Retains a stream in full while the shared output budget holds. Once the budget is exceeded the
 * stream keeps a head and a tail (both cut on code-point boundaries) and reports exactly how many
 * bytes were discarded. Memory stays bounded by headLimit + tailLimit plus one chunk.
 */
class Capture {
  private full = ''; private head = ''; private tail = ''; private total = 0; private truncating = false;
  constructor(private readonly headLimit: number, private readonly tailLimit: number) {}
  push(chunk: string): void {
    this.total += Buffer.byteLength(chunk);
    if (this.truncating) { this.tail = lastBytes(this.tail + chunk, this.tailLimit); return; }
    this.full += chunk;
  }
  /** Switch to head/tail retention; the full text seen so far is split without loss of accounting. */
  truncate(): void {
    if (this.truncating) return; this.truncating = true;
    this.head = firstBytes(this.full, this.headLimit);
    this.tail = lastBytes(this.full.slice(this.head.length), this.tailLimit);
    this.full = '';
  }
  get dropped(): number { return this.truncating ? this.total - Buffer.byteLength(this.head) - Buffer.byteLength(this.tail) : 0; }
  text(): string {
    if (!this.truncating) return this.full;
    return this.dropped ? `${this.head}\n…[${this.dropped} bytes truncated]…\n${this.tail}` : `${this.head}${this.tail}`;
  }
}
export async function runProcess(binary: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
  if (options.signal?.aborted) throw new AppError('cancelled', 'Execution cancelled');
  const limit = options.maxBytes ?? 2 * 1024 * 1024; const truncate = options.overflow === 'truncate';
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    // The budget covers both streams together: below it everything is kept; above it each stream keeps
    // a quarter of the budget as head and an eighth as tail, so retained evidence stays under the budget.
    const stdout = new Capture(Math.floor(limit / 4), Math.floor(limit / 8)); const stderr = new Capture(Math.floor(limit / 4), Math.floor(limit / 8));
    let pending = ''; let bytes = 0;
    let failure: Error | undefined; let escalation: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try { if (process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); }
      catch { /* Already exited. */ }
    };
    const stop = (error: Error) => {
      if (failure) return; failure = error; kill('SIGTERM');
      escalation = setTimeout(() => kill('SIGKILL'), 500);
    };
    const abort = () => stop(new AppError('cancelled', 'Execution cancelled'));
    const timer = setTimeout(() => stop(new AppError('timeout', 'Execution exceeded its time limit')), options.timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    // Avoid splitting UTF-8 code points between chunks.
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    // Account a chunk against the shared budget. In fail mode the first overflow terminates the
    // process; in truncate mode the chunk is retained first so the head is preserved, then both
    // streams switch to head/tail retention.
    const account = (capture: Capture, chunk: string): boolean => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > limit && !truncate) { stop(new AppError('output_limit', 'Engine output exceeded its limit')); return false; }
      capture.push(chunk);
      if (bytes > limit) { stdout.truncate(); stderr.truncate(); }
      return true;
    };
    child.stdout.on('data', (chunk: string) => {
      if (!account(stdout, chunk)) return;
      pending += chunk;
      const lines = pending.split('\n'); pending = lines.pop()!;
      try { for (const line of lines) if (line.trim()) options.onLine?.(line); }
      catch (error) { stop(error instanceof Error ? error : new Error(String(error))); }
    });
    child.stderr.on('data', (chunk: string) => { account(stderr, chunk); });
    child.stdin.on('error', () => { /* Early exit or cancellation closes stdin. */ });
    child.once('error', error => { failure = new AppError('engine_unavailable', `Unable to launch ${binary}: ${(error as NodeJS.ErrnoException).code ?? 'unknown'}`); });
    child.once('close', code => {
      clearTimeout(timer); if (escalation) clearTimeout(escalation);
      // Kill any detached descendants even after their immediate parent exits.
      kill('SIGKILL'); options.signal?.removeEventListener('abort', abort);
      try { if (pending.trim() && !failure) options.onLine?.(pending); }
      catch (error) { failure = error instanceof Error ? error : new Error(String(error)); }
      if (failure) reject(failure); else resolve({ stdout: stdout.text(), stderr: stderr.text(), exitCode: code ?? 1, truncated: stdout.dropped + stderr.dropped > 0 });
    });
    child.stdin.end(options.input ?? '');
  });
}
