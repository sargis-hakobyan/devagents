import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import type { Validator, ValidationResult } from '../../domain/engine.js';
import { assertValidationCommand } from '../../domain/validation.js';
import { runProcess } from '../process.js';
import { safeEnvironment, sandboxFlags, verifyCodex } from './sandbox.js';
import { nodeToolPath, workspaceRuntime } from '../node-tools.js';
import { AppError } from '../../domain/errors.js';

export class CodexValidator implements Validator {
  constructor(private readonly dataDir: string, private readonly binary = 'codex', private readonly options: { scanLimit?: number } = {}) {}
  async preflight(cwd: string, commands: { executable: string; args: string[] }[], signal: AbortSignal, rules: boolean): Promise<void> {
    const names = [...new Set(commands.map(c => c.executable).filter(e => !e.includes('/')))];
    const code = `const fs=require('node:fs'),path=require('node:path');const missing=${JSON.stringify(names)}.filter(name=>!process.env.PATH.split(path.delimiter).some(dir=>{try{fs.accessSync(path.join(dir,name),fs.constants.X_OK);return fs.statSync(path.join(dir,name)).isFile()}catch{return false}}));if(missing.length){console.error('Missing validation executables: '+missing.join(', '));process.exitCode=1}`;
    const result = await this.run(cwd, { executable: 'node', args: ['-e', code] }, signal, 10000, rules);
    if (result.exitCode !== 0) throw new AppError('environment_blocked', `Environment blocked: ${result.output.slice(-2000)}. Required tools are not available on the task environment PATH.`);
  }
  async execute(cwd: string, command: { executable: string; args: string[] }, signal: AbortSignal, timeoutMs: number, devagentsRules = true): Promise<ValidationResult> {
    assertValidationCommand(command, devagentsRules);
    return this.run(cwd, command, signal, timeoutMs, devagentsRules);
  }
  private async run(cwd: string, command: { executable: string; args: string[] }, signal: AbortSignal, timeoutMs: number, devagentsRules: boolean): Promise<ValidationResult> {
    const home = join(this.dataDir, 'validation', randomUUID()); const temp = join(home, 'tmp');
    await mkdir(temp, { recursive: true, mode: 0o700 });
    try {
      const runtime = devagentsRules ? undefined : await workspaceRuntime(this.dataDir, cwd);
      const toolPath = await nodeToolPath(temp, devagentsRules, runtime);
      await verifyCodex(this.binary, home);
      const args = [
        ...await sandboxFlags(cwd, { readPaths: ['project:/**'], writePaths: devagentsRules ? [] : ['project:/**'], allowCommands: true, allowPush: false }, temp, this.options.scanLimit, devagentsRules, false, runtime, signal),
        // Node 24.22 async output to socket-backed stdio was lost in the offline Linux
        // sandbox. A kernel pipe to cat preserves output without enabling networking;
        // pipefail preserves the command's status.
        // "$@" passes argv literally: no model-supplied text is interpreted by this wrapper.
        'sandbox', '-C', cwd, '-P', 'devagents', '--', '/bin/bash', '-o', 'pipefail', '-c', '"$@" 2>&1 | /bin/cat', 'devagents-validation',
        command.executable === 'node' && devagentsRules ? process.execPath : command.executable, ...command.args,
      ];
      const env = safeEnvironment(home, temp);
      env.PATH = toolPath;
      if (runtime) env.HOME = runtime;
      // The validation child has no access to credentials or the original checkout.
      // Oversized output is truncated (head and tail kept) and recorded as evidence rather than failing the task outright.
      const result = await runProcess(this.binary, args, { cwd, env, signal, timeoutMs, maxBytes: 1024 * 1024, overflow: 'truncate' });
      const validation = { ...command, exitCode: result.exitCode, output: `${result.stdout}${result.stderr}`, truncated: result.truncated };
      return validation;
    } finally { await rm(home, { recursive: true, force: true }); }
  }
}
