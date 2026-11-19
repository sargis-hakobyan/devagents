import { randomUUID } from 'node:crypto';
import { validationEvidence } from './validation-evidence.js';
import type { ValidationResult } from '../domain/engine.js';
import { AppError } from '../domain/errors.js';
import { assertValidationEnvironment, type ValidationCommand } from '../domain/validation.js';

/** Environment recovery is separate from code repair. Check source immutability for each
 * validation pass, then let setup make reviewable changes before a fresh full pass.
 */
export async function validateWithSetup(options: {
  commands: ValidationCommand[];
  rules: boolean;
  digest(): Promise<string>;
  execute(command: ValidationCommand): Promise<ValidationResult>;
  record(result: ValidationResult): void | Promise<void>;
  started?(command: ValidationCommand, validationId: string): void | Promise<void>;
  failed?(command: ValidationCommand, validationId: string, error: string): void | Promise<void>;
  recover(feedback: string): Promise<void>;
}): Promise<ValidationResult[]> {
  for (let attempt = 0; ; attempt++) {
    const before = await options.digest();
    const evidence: ValidationResult[] = [];
    let environmentError: Error | undefined;
    for (const command of options.commands) {
      const validationId = randomUUID();
      await options.started?.(command, validationId);
      let result: ValidationResult;
      try { result = await options.execute(command); }
      catch (error) { await options.failed?.(command, validationId, error instanceof Error ? error.message : String(error)); throw error; }
      evidence.push(result); await options.record({ ...result, validationId });
      if (result.timedOut) throw new AppError('validation_timeout', `Validation timed out: ${[command.executable, ...command.args].join(' ')}. Partial output is saved in Activity. Diagnose the stalled command before retrying; no code-repair attempt was used.`);
      try { assertValidationEnvironment(result); }
      catch (error) { environmentError = error as Error; break; }
    }
    if (before !== await options.digest()) throw new AppError('validation_mutated_files', 'Validation changed reviewed project files');
    if (!environmentError) return evidence;
    if (options.rules || attempt > 0) throw environmentError;
    await options.recover(validationEvidence(evidence));
  }
}
