import { AppError } from './errors.js';

export type ValidationCommand = { executable: string; args: string[] };
/**
 * The optional extra-rules validation allowlist. Shared by plan validation (before approval) and by the
 * runners and the Codex validator (at execution) so the two can never drift apart.
 * Shell syntax is never interpreted by DevAgents.
 */
export function assertValidationCommand(command: ValidationCommand, rules = true): void {
  if (!command.executable.trim() || [command.executable, ...command.args].some(a => a.includes('\0'))) throw new AppError('command_denied', 'Validation needs an executable and arguments without NUL bytes');
  if (!rules) return;
  const ok = (command.executable === 'node' && command.args[0] === '--test') ||
    (command.executable === 'npm' && command.args[0] === 'test') ||
    (command.executable === 'npm' && command.args[0] === 'run' && ['test', 'typecheck', 'lint', 'build'].includes(command.args[1] ?? ''));
  if (!ok) throw new AppError('command_denied', 'Validation supports node --test, npm test, and npm run test/typecheck/lint/build');
}
export function assertValidationCommands(commands: ValidationCommand[], subject: string, rules = true): void {
  if (!commands.length) throw new AppError('missing_validation', `${subject} needs at least one validation command`);
  commands.forEach(command => assertValidationCommand(command, rules));
}

/** A validation passed only when it exited 0 and its complete output was captured as evidence. */
export function validationFailed(results: { exitCode: number; truncated?: boolean }[]): boolean {
  return results.some(r => r.exitCode !== 0 || r.truncated === true);
}
export function describeValidationFailure(results: { exitCode: number; truncated?: boolean }[]): string {
  const truncated = results.some(r => r.truncated);
  return truncated ? 'Validation failed or produced more output than the evidence limit allows (truncated below); make the checks pass and reduce their output' : 'Validation failed';
}

/** Infrastructure failures cannot be repaired by changing application code. Keep the evidence,
 * then stop without spending a model repair attempt. Avoid classifying assertion failures this way.
 */
export function assertValidationEnvironment(result: { executable: string; exitCode: number; output: string }): void {
  if (result.exitCode === 0) return;
  if (/Failed to execvp .*No such file or directory|(?:command not found|not found: (?:pnpm|npm|yarn))|Cannot find package '[^']+' imported from|Cannot find module '[^'\n]*node_modules\//.test(result.output)) {
    throw new AppError('environment_blocked', `Environment blocked: ${result.executable} could not run with the available tools/dependencies. No code-repair attempt was used for this failure. ${result.output.slice(-2000)}`);
  }
}
