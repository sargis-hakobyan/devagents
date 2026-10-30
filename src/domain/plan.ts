import { scopeAgent, covers, assertSupportedWriteGrant, assertGrantShape } from './ownership.js';
import { executionAgent } from './execution-policy.js';
import { selectImplementer, independentReviewer } from './roles.js';
import { assertValidationCommands } from './validation.js';
import { AppError } from './errors.js';
import { Plan, type AgentDefinition, type TaskPlan } from './schemas.js';

export type PlanCheckOptions = { platform?: NodeJS.Platform; devagentsRules?: boolean };
/**
 * Validates a plan with the same role, command and write-grant rules the runners enforce, so a plan
 * presented for approval is one that can actually execute. Execution re-checks everything.
 */
export function validatePlan(input: unknown, projectId: string, agents: AgentDefinition[], options: PlanCheckOptions = {}): TaskPlan {
  const platform = options.platform ?? process.platform;
  const rules = options.devagentsRules ?? true;
  agents = agents.map(a => executionAgent(a, rules));
  const plan = Plan.parse(input);
  const byId = new Map(plan.items.map(item => [item.id, item]));
  if (byId.size !== plan.items.length) throw new AppError('invalid_plan', 'Duplicate work item IDs');
  if (new Set(plan.items.map(i => i.branch)).size !== plan.items.length) throw new AppError('invalid_plan', 'Work items must own unique branches');
  const visiting = new Set<string>(); const visited = new Set<string>(); const implementers = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new AppError('invalid_plan', 'Dependency cycle');
    if (visited.has(id)) return;
    const item = byId.get(id);
    if (!item) throw new AppError('invalid_plan', `Unknown dependency: ${id}`);
    if (item.projectId !== projectId) throw new AppError('invalid_plan', 'Plan cannot access another project');
    const candidate = selectImplementer(agents, item);
    if (!candidate) throw new AppError('missing_capability', `No available agent satisfies ${id}`);
    item.ownedPaths?.forEach(assertGrantShape);
    const scoped = rules && item.ownedPaths ? scopeAgent(candidate, item.ownedPaths) : candidate;
    if (rules) scoped.permissions.writePaths.forEach(p => assertSupportedWriteGrant(p, platform));
    assertValidationCommands(item.validation, `Work item ${id}`, rules);
    implementers.add(candidate.id);
    visiting.add(id); item.dependsOn.forEach(visit); visiting.delete(id); visited.add(id);
  };
  plan.items.forEach(item => visit(item.id));
  if (plan.items.length === 1 && plan.integration) throw new AppError('invalid_plan', 'Single-item plans use item validation; integration must be null');
  if (plan.items.length > 1) {
    if (!plan.integration || plan.items.some(item => !item.ownedPaths?.length || !item.assignedAgent)) throw new AppError('invalid_plan', 'Multi-item plans require assigned agents, owned paths, validation, and an explicit integration step');
    const integrator = agents.find(a => a.id === plan.integration!.assignedAgent && a.enabled && a.delegation.canReceiveTasks);
    if (!integrator || !integrator.permissions.writePaths.length) throw new AppError('missing_agent', 'No writable integration agent is available');
    const paths = plan.items.flatMap(item => item.ownedPaths!);
    if (rules) scopeAgent(integrator, paths).permissions.writePaths.forEach(p => assertSupportedWriteGrant(p, platform));
    if (paths.some(p => !integrator.permissions.readPaths.some(g => covers(g, p)))) throw new AppError('ownership_denied', 'Integration agent must be able to read all owned paths');
    assertValidationCommands(plan.integration.validation, 'Integration', rules);
    implementers.add(integrator.id);
  }
  if (!independentReviewer(agents, implementers)) throw new AppError('missing_agent', 'No enabled reviewer is independent of every implementer and the integration agent');
  return plan;
}
