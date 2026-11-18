/**
 * What a team member does, read from and written to the fields the backend already selects on:
 * a planner delegates with the planning capability; the three working responsibilities receive
 * tasks and carry the implementation, review or testing capability. Nothing here is a new field.
 */
export type Responsibility = 'plans' | 'implements' | 'reviews' | 'tests';
export type Effort = 'low' | 'medium' | 'high';
type Member = { capabilities: string[]; delegation: { canReceiveTasks: boolean; canDelegate: boolean } };
type Patch = Pick<Member, 'capabilities' | 'delegation'>;

export const RESPONSIBILITIES: readonly Responsibility[] = ['plans', 'implements', 'reviews', 'tests'];
const capability: Record<Responsibility, string> = { plans: 'planning', implements: 'implementation', reviews: 'review', tests: 'testing' };

/** A delegating member is a planner even before its planning capability is added. */
export const isPlanner = (m: Member): boolean => m.delegation.canDelegate;
export function responsibilities(m: Member): Responsibility[] {
  if (isPlanner(m)) return ['plans'];
  if (!m.delegation.canReceiveTasks) return [];
  return RESPONSIBILITIES.filter(r => r !== 'plans' && m.capabilities.includes(capability[r]));
}
export const responsibilityLine = (m: Member): string => responsibilities(m).join(' · ') || 'no responsibility';

/**
 * Ticking or unticking one responsibility. Planning is exclusive because the backend rejects a
 * member that both delegates and receives tasks, so ticking one side unticks the other. `offered` are the capabilities this build backs;
 * filesystem-write is added with implementation when available and never removed here.
 */
export function toggleResponsibility(m: Member, r: Responsibility, offered: readonly string[] = []): Patch {
  const without = (...names: string[]) => m.capabilities.filter(c => !names.includes(c));
  const working = [capability.implements, capability.reviews, capability.tests];
  if (r === 'plans') return isPlanner(m)
    ? { delegation: { canReceiveTasks: true, canDelegate: false }, capabilities: without(capability.plans) }
    : { delegation: { canReceiveTasks: false, canDelegate: true }, capabilities: [...without(capability.plans, ...working), capability.plans] };
  const delegation = { canReceiveTasks: true, canDelegate: false };
  if (!isPlanner(m) && responsibilities(m).includes(r)) return { delegation, capabilities: without(capability[r]) };
  // Ticking a working responsibility on a planner switches the member over: planning is given up.
  const added = [...without(capability[r], capability.plans), capability[r]];
  if (r === 'implements' && offered.includes('filesystem-write') && !added.includes('filesystem-write')) added.push('filesystem-write');
  return { delegation, capabilities: added };
}
