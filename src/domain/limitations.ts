import { z } from 'zod';

/**
 * Owner policy (2026-11-02): a check that cannot run because of the execution environment is
 * reported and the task moves on. Repair cycles are reserved for actual defects. These helpers
 * carry such reports from the planner (checks it knows need tools the sandbox lacks), the
 * implementer (checks it tried once and could not run) and the reviewer (who records them)
 * into the task outcome, where the user sees them.
 */
export const Limitation = z.string().min(1).max(1000);
export const LIMITATION_LIMIT = 20;

export function mergeLimitations(...lists: (readonly string[] | undefined)[]): string[] {
  const seen = new Set<string>(); const result: string[] = [];
  for (const list of lists) for (const raw of list ?? []) {
    const text = raw.trim(); const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key); result.push(text.slice(0, 1000));
    if (result.length >= LIMITATION_LIMIT) return result;
  }
  return result;
}
export const describeLimitations = (limitations: readonly string[]) => limitations.length ? ` · ${limitations.length} check${limitations.length === 1 ? '' : 's'} not run in this environment` : '';

export const planningLimitationInstructions = 'Every acceptance criterion must be verifiable by the declared validation commands or by inspecting the diff. Checks that need tools this sandbox does not provide (a browser or screenshots, a GUI, network services, external systems, manual QA) are not acceptance criteria: list them in manualChecks as advice for the user. They are reported with the result and never enforced through repair.';
export const implementationLimitationInstructions = 'If a check cannot run in this environment (missing browser, system library, network, service or tool), try once at most, then report it in limitations with the exact reason and continue. Do not retry environment limitations, rebuild the runtime or install system packages for them; do not treat them as failures.';
export const reviewLimitationInstructions = 'Limitations reported by the implementation (checks that could not run in this environment) and manualChecks in the plan are not findings: approve on the diff and the actual validation evidence, and copy them into your limitations list so they are recorded with the result. Reject only for defects in the change or failing declared validation.';
