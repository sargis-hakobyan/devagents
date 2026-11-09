/** A dispatch is a request to enter/continue a workflow, not a retry of its effects. */
export type DispatchClaim = { taskId: string; owner: string; generation: number; sequence: number };
export type DispatchRecord = {
  taskId: string; requested: number; handled: number; requestedVersion: number;
  generation: number; owner: string | null; claimed: number; queuedAt: string;
  heartbeatAt: string | null; blocker: string | null;
};
export type TaskScheduling = { status: 'queued' | 'running' | 'waiting' | 'draining' | 'held' | 'finished'; reason: string };
export type SchedulerStatus = {
  enabled: boolean; maxConcurrentTasks: number; maxConcurrentOperations: number;
  active: string[]; queued: number; runningOperations: number; waitingOperations: number;
  held: number; attention: { taskId: string; message: string }[];
};
