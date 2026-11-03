import { z } from 'zod';
import { Integration, Plan, ScopedPath, WorkItem } from '../domain/schemas.js';
import { Limitation } from '../domain/limitations.js';

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

export const ImplementationOutput = z.strictObject({
  summary: z.string().min(1),
  limitations: z.array(Limitation).max(10).default([]).describe('Checks that could not run in this environment (missing browser, library, network, tool), each with its reason. Tried once at most; not failures.'),
});
export const SetupOutput = z.strictObject({ ready: z.boolean(), summary: z.string().min(1), limitations: z.array(Limitation).max(10).default([]).describe('Optional checks unavailable here, not failures of declared validation. Report newly noticed limitations only.') });
export const QualityOutput = z.strictObject({
  summary: z.string().min(1),
  checks: z.array(z.strictObject({
    criterionId: z.string().min(1),
    status: z.enum(['passed', 'failed', 'blocked']),
    evidence: z.string().min(1).describe('Concrete command results or inspected code supporting this result; for blocked checks, the missing prerequisite.'),
  })).min(1),
  limitations: z.array(Limitation).max(10).default([]).describe('Optional checks that could not run. Required acceptance criteria must be reported as blocked in checks, never waived here.'),
});
export const ReviewOutput = z.strictObject({
  approved: z.boolean().describe('True only when requirements and validation pass and findings is empty.'),
  summary: z.string().min(1).describe('Review rationale, including positive observations and test evidence.'),
  findings: z.array(z.string().min(1)).describe('Actionable defects requiring repair only. Empty when approved. Do not include positive observations or passed checks.'),
  limitations: z.array(Limitation).max(10).default([]).describe('Only limitations newly noticed by this review (checks that could not run in this environment). Recorded reports are carried forward by the orchestrator; never findings.'),
}).superRefine((review, ctx) => {
  // A rejection with nothing to repair is malformed output, not a repair request worth a cycle.
  if (!review.approved && review.findings.length === 0) ctx.addIssue({ code: 'custom', path: ['findings'], message: 'A rejection must list at least one actionable finding' });
});

/** The planner's response: items must name an agent and owned paths; integration is explicit. */
export const PlanningOutput = Plan.extend({ items: z.array(WorkItem.extend({ assignedAgent: z.string(), ownedPaths: z.array(ScopedPath).min(1) })).min(1).max(30), integration: Integration.nullable() });
/** The literal schema of the opt-in connection check; registered here so the strict-schema test covers it. */
export const connectionCheckSchema: Record<string, unknown> = { type: 'object', properties: { connected: { type: 'boolean', enum: [true] } }, required: ['connected'], additionalProperties: false };
/**
 * Every JSON schema this build sends to a model. Strict structured output refuses any object whose
 * `required` omits a property, so each entry is asserted by tests/unit/output-schema.test.ts; a new
 * model call site must register its schema here.
 */
export function modelSchemas(): Record<string, Record<string, unknown>> {
  return { planning: outputJsonSchema(PlanningOutput), setup: outputJsonSchema(SetupOutput), implementation: outputJsonSchema(ImplementationOutput), qa: outputJsonSchema(QualityOutput), review: outputJsonSchema(ReviewOutput), connectionCheck: connectionCheckSchema };
}
