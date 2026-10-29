import { z } from 'zod';
import { ScopedPath } from '../domain/schemas.js';

/** Generation hints are separate from the authoritative local Zod/policy checks. */
export function outputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const result = z.toJSONSchema(schema, {
    override({ zodSchema, jsonSchema }) {
      delete jsonSchema.default;
      if (zodSchema === ScopedPath) {
        // The pinned Codex runtime/model truncates even a one-path response with
        // ScopedPath's negated-character/NUL regex. Keep it in local validation.
        delete jsonSchema.pattern;
        jsonSchema.description = 'Project-scoped path, e.g. project:/src/file.ts or project:/src/**. No traversal, backslashes or NUL characters.';
      }
    },
  });
  delete result.$schema;
  return result;
}

export const ImplementationOutput = z.strictObject({ summary: z.string().min(1) });
export const ReviewOutput = z.strictObject({
  approved: z.boolean().describe('True only when requirements and validation pass and findings is empty.'),
  summary: z.string().min(1).describe('Review rationale, including positive observations and test evidence.'),
  findings: z.array(z.string().min(1)).describe('Actionable defects requiring repair only. Empty when approved. Do not include positive observations or passed checks.'),
});
