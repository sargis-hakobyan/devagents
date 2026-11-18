import { useRef, useState } from 'preact/hooks';
import { api, ApiError, SignedOutError, type AvailableTicket, type Task, type TicketRead } from './api';
import { clearAttempt, readAttempt, saveAttempt } from './attempt';
import { onSignedOut, retryNow } from './state';

export const ticketIdentity = (projectId: string, source: string, key: string) => JSON.stringify([projectId, source, key]);
export const availableIdentity = (ticket: AvailableTicket) => ticketIdentity(ticket.projectId, ticket.source.id, ticket.key);

/** Shares the submit form's durable retry identity, including after navigation or a lost response. */
export function useTicketStart() {
  const lock = useRef(false);
  const [restored] = useState(() => { try { return { attempt: readAttempt(), error: '' }; } catch (e) { return { attempt: undefined, error: String(e) }; } });
  const [attempt, setAttempt] = useState(restored.attempt);
  const [error, setError] = useState(restored.error);
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState<AvailableTicket>();
  const [accepted, setAccepted] = useState<Task[]>([]);
  const [notice, setNotice] = useState('');

  const start = async (ticket?: AvailableTicket) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setNotice(''); setStarting(ticket);
    try {
      // Read again: the submit form may have left an unresolved request since this board mounted.
      let next = readAttempt();
      if (next && ticket) { setAttempt(next); throw new Error('Resolve the previous submission before starting another ticket.'); }
      if (!next) {
        if (!ticket) throw new Error('There is no saved submission to retry.');
        const [read, defaults] = await Promise.all([
          api<TicketRead>(`/tickets/content?${new URLSearchParams({ projectId: ticket.projectId, source: ticket.source.id, key: ticket.key })}`),
          api<{ projects: { projectId: string; mode: 'autonomous' | 'plan-approval' | null }[] }>('/submission-options'),
        ]);
        const project = defaults.projects.find(p => p.projectId === ticket.projectId);
        if (!project) throw new Error('This project is no longer available. Refresh the board.');
        next = { key: crypto.randomUUID(), at: new Date().toISOString(), payload: {
          projectId: ticket.projectId, request: read.request, acceptanceCriteria: [], mode: project.mode ?? 'plan-approval',
          ticket: { source: ticket.source.id, key: ticket.key, readAt: read.ticket.readAt, ...(read.ticket.url ? { url: read.ticket.url } : {}) },
        } };
        // A storage failure must stop before POST, so a retry can never lose its identity.
        saveAttempt(next);
      }
      setAttempt(next);
      const task = await api<Task>('/tasks', { method: 'POST', body: next.payload, idempotencyKey: next.key });
      if (!task?.id) throw new Error('The service response did not identify the created task. Retry to check the outcome.');
      setAccepted(tasks => [...tasks.filter(t => t.id !== task.id), task]);
      setNotice(`Started ${next.payload.ticket?.key ?? 'task'}.`);
      clearAttempt(); setAttempt(undefined); retryNow();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      if (e instanceof ApiError && ((e.status >= 400 && e.status < 500 && ![401, 403, 408, 409].includes(e.status)) || ['team_archived', 'team_not_ready', 'not_found'].includes(e.code))) {
        try { clearAttempt(); setAttempt(undefined); } catch { /* Keep the retry visible if storage cannot be cleared. */ }
      }
      if (e instanceof SignedOutError) onSignedOut();
    } finally { lock.current = false; setBusy(false); setStarting(undefined); }
  };
  return { start, busy, starting, attempt, error, notice, accepted };
}
