import { z } from 'zod';

export const ImplementationOutput = z.strictObject({ summary: z.string().min(1) });
export const ReviewOutput = z.strictObject({
  approved: z.boolean().describe('True only when requirements and validation pass and findings is empty.'),
  summary: z.string().min(1).describe('Review rationale, including positive observations and test evidence.'),
  findings: z.array(z.string().min(1)).describe('Actionable defects requiring repair only. Empty when approved. Do not include positive observations or passed checks.'),
});
