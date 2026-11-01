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
  record(result: ValidationResult): void;
  recover(feedback: string): Promise<void>;
}): Promise<ValidationResult[]> {
  for (let attempt = 0; ; attempt++) {
    const before = await options.digest();
    const evidence: ValidationResult[] = [];
    let environmentError: Error | undefined;
    for (const command of options.commands) {
      const result = await options.execute(command);
      evidence.push(result); options.record(result);
      try { assertValidationEnvironment(result); }
      catch (error) { environmentError = error as Error; break; }
    }
    if (before !== await options.digest()) throw new AppError('validation_mutated_files', 'Validation changed reviewed project files');
    if (!environmentError) return evidence;
    if (options.rules || attempt > 0) throw environmentError;
    await options.recover(JSON.stringify(evidence).slice(0, 50000));
  }
}
