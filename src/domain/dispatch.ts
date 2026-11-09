/** A dispatch is a request to enter/continue a workflow, not a retry of its effects. */
export type DispatchClaim = { taskId: string; owner: string; generation: number; sequence: number };
export type DispatchRecord = {
  taskId: string; requested: number; handled: number; requestedVersion: number;
  generation: number; owner: string | null; claimed: number; queuedAt: string;
  heartbeatAt: string | null; blocker: string | null;
};
