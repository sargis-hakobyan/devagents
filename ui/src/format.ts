import type { TaskState, TaskSummary } from './api';

export type Tone = 'ok' | 'run' | 'warn' | 'bad' | 'neutral';
export function taskState(t: Pick<TaskSummary, 'state' | 'error'>): { label: string; tone: Tone; icon: string } {
  switch (t.state) {
    case 'awaiting_mode': return { label: 'Awaiting mode choice', tone: 'warn', icon: '●' };
    case 'awaiting_plan_approval': return { label: 'Awaiting your approval', tone: 'warn', icon: '●' };
    case 'planning': return { label: 'Planning', tone: 'run', icon: '▶' };
    case 'ready': return { label: 'Queued', tone: 'neutral', icon: '…' };
    case 'running': return { label: 'Running', tone: 'run', icon: '▶' };
    case 'validating': return { label: 'Validating', tone: 'run', icon: '▶' };
    case 'reviewing': return { label: 'Reviewing', tone: 'run', icon: '▶' };
    case 'repairing': return { label: 'Repairing', tone: 'run', icon: '↻' };
    case 'committing': return { label: 'Committing', tone: 'run', icon: '▶' };
    case 'completed': return { label: 'Completed', tone: 'ok', icon: '✓' };
    case 'cancelled': return { label: 'Cancelled by you', tone: 'neutral', icon: '⊘' };
    case 'failed': return /Service shutdown interrupted/.test(t.error ?? '') ? { label: 'Interrupted by shutdown', tone: 'warn', icon: '⚠' } : { label: 'Failed', tone: 'bad', icon: '✕' };
    default: return { label: t.state, tone: 'neutral', icon: '·' };
  }
}
export function itemState(state: string): { label: string; tone: Tone; icon: string } {
  switch (state) {
    case 'pending': return { label: 'Pending', tone: 'neutral', icon: '…' };
    case 'creating': return { label: 'Creating worktree', tone: 'run', icon: '▶' };
    case 'running': return { label: 'Implementing', tone: 'run', icon: '▶' };
    case 'validating': return { label: 'Validating', tone: 'run', icon: '▶' };
    case 'reviewing': return { label: 'Reviewing', tone: 'run', icon: '▶' };
    case 'repairing': return { label: 'Repairing', tone: 'run', icon: '↻' };
    case 'checkpointing': return { label: 'Checkpointing', tone: 'run', icon: '▶' };
    case 'reviewed': return { label: 'Reviewed', tone: 'ok', icon: '✓' };
    case 'integrating': return { label: 'Integrating', tone: 'run', icon: '▶' };
    case 'completed': return { label: 'Integrated', tone: 'ok', icon: '✓' };
    case 'failed': return { label: 'Failed', tone: 'bad', icon: '✕' };
    case 'cancelled': return { label: 'Cancelled by you', tone: 'neutral', icon: '⊘' };
    case 'aborted': return { label: 'Aborted (sibling failed)', tone: 'warn', icon: '⚠' };
    case 'interrupted': return { label: 'Interrupted by shutdown', tone: 'warn', icon: '⚠' };
    case 'blocked': return { label: 'Blocked', tone: 'neutral', icon: '⊘' };
    // Single-item tasks report the task state as the item state until item evidence exists.
    case 'awaiting_mode': return { label: 'Awaiting mode choice', tone: 'warn', icon: '●' };
    case 'awaiting_plan_approval': return { label: 'Awaiting approval', tone: 'warn', icon: '●' };
    case 'planning': return { label: 'Planning', tone: 'run', icon: '▶' };
    case 'ready': return { label: 'Queued', tone: 'neutral', icon: '…' };
    case 'committing': return { label: 'Committing', tone: 'run', icon: '▶' };
    default: return { label: state, tone: 'neutral', icon: '·' };
  }
}
export const activeStates: TaskState[] = ['planning', 'ready', 'running', 'validating', 'reviewing', 'committing', 'repairing'];
export const attentionStates: TaskState[] = ['awaiting_mode', 'awaiting_plan_approval'];
export const finishedStates: TaskState[] = ['completed', 'failed', 'cancelled'];

export function formatTime(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return iso;
  const now = new Date(); const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${time.slice(0, 5)}`;
}
export function relative(iso: string | Date | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const t = typeof iso === 'string' ? Date.parse(iso) : iso.getTime(); if (Number.isNaN(t)) return '—';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s} s ago`; const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 48) return `${h} h ago`; return `${Math.round(h / 24)} d ago`;
}
export function elapsed(fromIso: string, toIso?: string, now = Date.now()): string {
  const from = Date.parse(fromIso); const to = toIso ? Date.parse(toIso) : now;
  const s = Math.max(0, Math.round((to - from) / 1000)); const m = Math.floor(s / 60); const h = Math.floor(m / 60);
  return h ? `${h} h ${m % 60} min` : m ? `${m} min ${s % 60} s` : `${s} s`;
}
export function shortSha(sha: string | undefined, n = 7): string { return sha ? sha.slice(0, n) : '—'; }
export function command(c: { executable: string; args: string[] }): string { return [c.executable, ...c.args].join(' '); }
export function truncate(text: string, max: number): string { return text.length > max ? `${text.slice(0, max)}…` : text; }
