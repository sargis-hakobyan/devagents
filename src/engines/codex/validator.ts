import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { Validator, ValidationResult } from '../../domain/engine.js';
import { AppError } from '../../domain/errors.js';
import { runProcess } from '../process.js';
import { safeEnvironment, sandboxFlags, verifyCodex } from './sandbox.js';

export function assertValidationCommand(command: { executable: string; args: string[] }): void {
  // A small explicit v0.1 surface. Shell syntax is never interpreted by DevAgents.
  const ok = (command.executable === 'node' && command.args[0] === '--test') ||
    (command.executable === 'npm' && command.args[0] === 'test') ||
    (command.executable === 'npm' && command.args[0] === 'run' && ['test', 'typecheck', 'lint', 'build'].includes(command.args[1] ?? ''));
  if (!ok || command.args.some(a => a.includes('\0'))) throw new AppError('command_denied', 'Validation supports node --test, npm test, and npm run test/typecheck/lint/build');
}
export class CodexValidator implements Validator {
  constructor(private readonly dataDir: string, private readonly binary = 'codex') {}
  async execute(cwd: string, command: { executable: string; args: string[] }, signal: AbortSignal, timeoutMs: number): Promise<ValidationResult> {
    assertValidationCommand(command);
    const home = join(this.dataDir, 'validation', randomUUID()); const temp = join(home, 'tmp');
    await mkdir(temp, { recursive: true, mode: 0o700 });
    await verifyCodex(this.binary, home);
    const args = [
      ...await sandboxFlags(cwd, { readPaths: ['project:/**'], writePaths: [], allowCommands: true, allowPush: false }, temp),
      'sandbox', '-C', cwd, '-P', 'devagents', '--', command.executable === 'node' ? process.execPath : 'npm', ...command.args,
    ];
    const env = safeEnvironment(home, temp);
    // The validation child has no access to credentials or the original checkout.
    const result = await runProcess(this.binary, args, { cwd, env, signal, timeoutMs, maxBytes: 1024 * 1024 });
    return { ...command, exitCode: result.exitCode, output: `${result.stdout}${result.stderr}` };
  }
}
