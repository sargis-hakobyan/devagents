import { AppError } from './errors.js';

export type ValidationCommand = { executable: string; args: string[] };
/**
 * The explicit v0.1 validation surface. Shared by plan validation (before approval) and by the
 * runners and the Codex validator (at execution) so the two can never drift apart.
 * Shell syntax is never interpreted by DevAgents.
 */
export function assertValidationCommand(command: ValidationCommand): void {
  const ok = (command.executable === 'node' && command.args[0] === '--test') ||
    (command.executable === 'npm' && command.args[0] === 'test') ||
    (command.executable === 'npm' && command.args[0] === 'run' && ['test', 'typecheck', 'lint', 'build'].includes(command.args[1] ?? ''));
  if (!ok || command.args.some(a => a.includes('\0'))) throw new AppError('command_denied', 'Validation supports node --test, npm test, and npm run test/typecheck/lint/build');
}
export function assertValidationCommands(commands: ValidationCommand[], subject: string): void {
  if (!commands.length) throw new AppError('missing_validation', `${subject} needs at least one validation command`);
  commands.forEach(assertValidationCommand);
}
