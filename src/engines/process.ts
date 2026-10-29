import { spawn } from 'node:child_process';
import { AppError } from '../domain/errors.js';

export type ProcessOptions = {
  cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs: number;
  input?: string; onLine?: (line: string) => void; maxBytes?: number;
  /** 'fail' (default) terminates the process when output exceeds maxBytes; 'truncate' keeps head and tail and marks the result. */
  overflow?: 'fail' | 'truncate';
};
export type ProcessResult = { stdout: string; stderr: string; exitCode: number; truncated: boolean };
/** Keeps the first `headLimit` and last `tailLimit` bytes of a stream so memory stays bounded. */
class Capture {
  private head = ''; private tail = ''; dropped = 0;
  constructor(private readonly headLimit: number, private readonly tailLimit: number) {}
  push(chunk: string): void {
    const room = this.headLimit - Buffer.byteLength(this.head);
    if (room >= Buffer.byteLength(chunk)) { this.head += chunk; return; }
    const kept = room > 0 ? chunk.slice(0, room) : '';
    this.head += kept; const rest = chunk.slice(kept.length);
    this.dropped += Buffer.byteLength(rest);
    this.tail = (this.tail + rest).slice(-this.tailLimit);
  }
  text(): string { return this.dropped ? `${this.head}\n…[${this.dropped - Buffer.byteLength(this.tail)} bytes truncated]…\n${this.tail}` : this.head; }
}
export async function runProcess(binary: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
  if (options.signal?.aborted) throw new AppError('cancelled', 'Execution cancelled');
  const limit = options.maxBytes ?? 2 * 1024 * 1024; const truncate = options.overflow === 'truncate';
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const stdout = new Capture(Math.floor(limit / 2), Math.floor(limit / 8)); const stderr = new Capture(Math.floor(limit / 2), Math.floor(limit / 8));
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
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > limit && !truncate) return stop(new AppError('output_limit', 'Engine output exceeded its limit'));
      stdout.push(chunk); pending += chunk;
      const lines = pending.split('\n'); pending = lines.pop()!;
      try { for (const line of lines) if (line.trim()) options.onLine?.(line); }
      catch (error) { stop(error instanceof Error ? error : new Error(String(error))); }
    });
    child.stderr.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > limit && !truncate) return stop(new AppError('output_limit', 'Engine output exceeded its limit'));
      stderr.push(chunk);
    });
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
