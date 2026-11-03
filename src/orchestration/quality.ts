import type { Task, AgentDefinition } from '../domain/schemas.js';
import { AppError } from '../domain/errors.js';
import { QualityOutput } from './outputs.js';
import type { z } from 'zod';

/** QA is an execution gate, independent of whether the planner created a testing item. */
export function selectQualityAgent(agents: AgentDefinition[], excluded: Iterable<string>): AgentDefinition | undefined {
  const ids = new Set(excluded);
  const testers = agents.filter(a => a.enabled && a.capabilities.includes('testing'));
  const qa = testers.find(a => a.delegation.canReceiveTasks && !ids.has(a.id));
  if (testers.length && !qa) throw new AppError('missing_qa_agent', 'QA is enabled but no QA agent is independent of the implementers and reviewer');
  return qa;
}

export function qualityCriteria(task: Task): { id: string; description: string }[] {
  return [
    { id: 'request', description: task.request },
    ...task.acceptanceCriteria.map((description, i) => ({ id: `task:${i}`, description })),
    ...task.plan!.items.flatMap(item => item.acceptanceCriteria.map((description, i) => ({ id: `item:${item.id}:${i}`, description }))),
  ];
}

export function qualityResult(task: Task, report: z.infer<typeof QualityOutput>) {
  const expected = new Set(qualityCriteria(task).map(c => c.id));
  const reported = new Set(report.checks.map(c => c.criterionId));
  if (reported.size !== report.checks.length || reported.size !== expected.size || [...reported].some(id => !expected.has(id))) {
    throw new AppError('invalid_qa_report', 'QA must report exactly one result for every required criterion; missing, duplicate or unknown criteria cannot pass');
  }
  const failed = report.checks.filter(c => c.status === 'failed');
  const blocked = report.checks.filter(c => c.status === 'blocked');
  return { state: blocked.length ? 'blocked' : failed.length ? 'failed' : 'passed',
    feedback: [...blocked, ...failed].map(c => `${c.criterionId}: ${c.evidence}`).join('\n') };
}
