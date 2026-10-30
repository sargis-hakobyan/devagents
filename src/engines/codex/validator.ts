import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { Validator, ValidationResult } from '../../domain/engine.js';
import { assertValidationCommand } from '../../domain/validation.js';
import { runProcess } from '../process.js';
import { safeEnvironment, sandboxFlags, verifyCodex } from './sandbox.js';

export class CodexValidator implements Validator {
  constructor(private readonly dataDir: string, private readonly binary = 'codex', private readonly options: { scanLimit?: number } = {}) {}
  async execute(cwd: string, command: { executable: string; args: string[] }, signal: AbortSignal, timeoutMs: number): Promise<ValidationResult> {
    assertValidationCommand(command);
    const home = join(this.dataDir, 'validation', randomUUID()); const temp = join(home, 'tmp');
    await mkdir(temp, { recursive: true, mode: 0o700 });
    await verifyCodex(this.binary, home);
    const args = [
      ...await sandboxFlags(cwd, { readPaths: ['project:/**'], writePaths: [], allowCommands: true, allowPush: false }, temp, this.options.scanLimit),
      'sandbox', '-C', cwd, '-P', 'devagents', '--', command.executable === 'node' ? process.execPath : 'npm', ...command.args,
    ];
    const env = safeEnvironment(home, temp);
    // The validation child has no access to credentials or the original checkout.
    // Oversized output is truncated (head and tail kept) and recorded as evidence rather than failing the task outright.
    const result = await runProcess(this.binary, args, { cwd, env, signal, timeoutMs, maxBytes: 1024 * 1024, overflow: 'truncate' });
    return { ...command, exitCode: result.exitCode, output: `${result.stdout}${result.stderr}`, truncated: result.truncated };
  }
}
