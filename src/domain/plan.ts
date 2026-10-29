import { AppError } from './errors.js';
import { Plan, type AgentDefinition, type TaskPlan } from './schemas.js';

export function validatePlan(input: unknown, projectId: string, agents: AgentDefinition[]): TaskPlan {
  const plan = Plan.parse(input);
  const byId = new Map(plan.items.map(item => [item.id, item]));
  if (byId.size !== plan.items.length) throw new AppError('invalid_plan', 'Duplicate work item IDs');
  if (new Set(plan.items.map(i => i.branch)).size !== plan.items.length) throw new AppError('invalid_plan', 'Work items must own unique branches');
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new AppError('invalid_plan', 'Dependency cycle');
    if (visited.has(id)) return;
    const item = byId.get(id);
    if (!item) throw new AppError('invalid_plan', `Unknown dependency: ${id}`);
    if (item.projectId !== projectId) throw new AppError('invalid_plan', 'Plan cannot access another project');
    const candidate = agents.find(a => a.enabled && a.delegation.canReceiveTasks && (!item.assignedAgent || item.assignedAgent === a.id) && item.requiredCapabilities.every(c => a.capabilities.includes(c)));
    if (!candidate) throw new AppError('missing_capability', `No available agent satisfies ${id}`);
    visiting.add(id); item.dependsOn.forEach(visit); visiting.delete(id); visited.add(id);
  };
  plan.items.forEach(item => visit(item.id));
  return plan;
}
