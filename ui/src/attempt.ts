/** Only task input and retry identity live here. Authentication stays in HttpOnly cookies/memory. */
export type Payload = { projectId: string; request: string; acceptanceCriteria: string[]; teamId?: string; mode?: 'autonomous' | 'plan-approval' };
export type Attempt = { key: string; payload: Payload; at: string };
export const attemptStorageKey = 'devagents.submission.v1';
export function readAttempt(): Attempt | undefined {
  const raw = sessionStorage.getItem(attemptStorageKey);
  if (!raw) return undefined;
  if (raw.length > 262144) throw new Error('Stored attempt is too large. Abandon it explicitly before submitting new work.');
  const a = JSON.parse(raw) as Attempt;
  const p = a?.payload;
  if (!a || typeof a.key !== 'string' || !/^[a-f0-9-]{36}$/.test(a.key) || typeof a.at !== 'string' || !p || typeof p.projectId !== 'string' || typeof p.request !== 'string' || !Array.isArray(p.acceptanceCriteria) || !p.acceptanceCriteria.every(c => typeof c === 'string') || Object.keys(a).some(k => !['key', 'payload', 'at'].includes(k)) || Object.keys(p).some(k => !['projectId', 'request', 'acceptanceCriteria', 'teamId', 'mode'].includes(k)) || (p.teamId !== undefined && typeof p.teamId !== 'string') || (p.mode !== undefined && !['autonomous', 'plan-approval'].includes(p.mode))) throw new Error('Stored attempt is invalid. Abandon it explicitly before submitting new work.');
  return a;
}
export function saveAttempt(a: Attempt) { sessionStorage.setItem(attemptStorageKey, JSON.stringify(a)); }
export function clearAttempt() { sessionStorage.removeItem(attemptStorageKey); }
