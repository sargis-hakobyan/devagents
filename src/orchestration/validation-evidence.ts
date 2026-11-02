import type { ValidationResult } from '../domain/engine.js';
import { environmentSecrets, redactValues } from '../telemetry/redact.js';

/** Preserve every command and exit status; a verbose first test must not hide later checks.
 * Prompt previews are distinct from capture truncation, which still blocks validation.
 */
export function validationEvidence(results: ValidationResult[], secrets: readonly string[] = environmentSecrets()): string {
  const budget = Math.floor(40000 / Math.max(1, results.length));
  // Redact before shortening; otherwise a boundary can leave an unrecognizable partial secret.
  const safe = redactValues(results, secrets) as ValidationResult[];
  return JSON.stringify(safe.map(result => {
    const preview = result.output.length > budget;
    const head = Math.floor(budget / 3); const tail = budget - head;
    return { ...result, output: preview
      ? `${result.output.slice(0, head)}\n[Output shortened for this prompt; full captured evidence is stored with the task]\n${tail ? result.output.slice(-tail) : ''}`
      : result.output, outputPreview: preview };
  }));
}
