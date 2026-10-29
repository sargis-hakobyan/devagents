import { scopeAgent, covers } from './ownership.js';
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
    if (candidate && item.ownedPaths) scopeAgent(candidate, item.ownedPaths);
    if (!candidate) throw new AppError('missing_capability', `No available agent satisfies ${id}`);
    visiting.add(id); item.dependsOn.forEach(visit); visiting.delete(id); visited.add(id);
  };
  plan.items.forEach(item => visit(item.id));
  if (plan.items.length === 1 && plan.integration) throw new AppError('invalid_plan', 'Single-item plans use item validation; integration must be null');
  if (plan.items.length > 1) {
    if (!plan.integration || plan.items.some(item => !item.ownedPaths?.length || !item.assignedAgent || !item.validation.length)) throw new AppError('invalid_plan', 'Multi-item plans require assigned agents, owned paths, validation, and an explicit integration step');
    const integrator = agents.find(a => a.id === plan.integration!.assignedAgent && a.enabled && a.delegation.canReceiveTasks);
    if (!integrator) throw new AppError('missing_agent', 'No available integration agent');
    const paths = plan.items.flatMap(item => item.ownedPaths!);
    scopeAgent(integrator, paths);
    if (paths.some(p => !integrator.permissions.readPaths.some(g => covers(g, p)))) throw new AppError('ownership_denied', 'Integration agent must be able to read all owned paths');
  }
  return plan;
}
