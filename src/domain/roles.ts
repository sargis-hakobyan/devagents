import type { AgentDefinition } from './schemas.js';

type ItemRequirements = { assignedAgent?: string | undefined; requiredCapabilities: string[] };
/**
 * Deterministic implementer selection shared by plan validation and execution: an enabled role
 * that can receive tasks, matches the assignment if any, has every required capability, and can write.
 */
export function selectImplementer(agents: AgentDefinition[], item: ItemRequirements): AgentDefinition | undefined {
  return agents.find(a => a.enabled && a.delegation.canReceiveTasks && (!item.assignedAgent || item.assignedAgent === a.id)
    && item.requiredCapabilities.every(c => a.capabilities.includes(c)) && a.permissions.writePaths.length > 0);
}
/** A reviewer must be independent of every implementer and the integration agent. */
export function independentReviewer(agents: AgentDefinition[], implementers: Iterable<string>): AgentDefinition | undefined {
  const excluded = new Set(implementers);
  return agents.find(a => a.enabled && a.delegation.canReceiveTasks && a.capabilities.includes('review') && !excluded.has(a.id));
}
