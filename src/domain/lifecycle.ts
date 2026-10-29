import { AppError } from './errors.js';
import type { TaskState } from './schemas.js';

const transitions: Record<TaskState, readonly TaskState[]> = {
  draft: ['awaiting_mode', 'planning', 'cancelled'],
  awaiting_mode: ['planning', 'cancelled'],
  planning: ['awaiting_plan_approval', 'ready', 'failed', 'cancelled'],
  awaiting_plan_approval: ['ready', 'cancelled'],
  ready: ['running', 'failed', 'cancelled'],
  running: ['validating', 'failed', 'cancelled'],
  validating: ['reviewing', 'repairing', 'failed', 'cancelled'],
  reviewing: ['completed', 'repairing', 'awaiting_external_approval', 'failed', 'cancelled'],
  repairing: ['running', 'failed', 'cancelled'],
  awaiting_external_approval: ['completed', 'failed', 'cancelled'],
  completed: [], failed: [], cancelled: [],
};
export function assertTransition(from: TaskState, to: TaskState): void {
  if (!transitions[from].includes(to)) throw new AppError('invalid_transition', `Cannot transition ${from} to ${to}`, 409);
}
export const terminalStates: readonly TaskState[] = ['completed', 'failed', 'cancelled'];
