import { AppError } from '../domain/errors.js';
import { TicketKey, TicketSource, ticketFileKind, type TicketComment, type TicketContent } from '../domain/tickets.js';
import type { ProjectIntegrationService } from './service.js';
import type { TrackerService } from './trackers.js';

export type TicketSources = { integrations?: ProjectIntegrationService | undefined; trackers?: TrackerService | undefined };
/** A ticket as the submit form shows it. Files are named only; where the tool serves them stays on the service. */
export type TicketView = {
  source: string; /** What the user calls the source, for example "Jira". */ name: string; key: string; title: string; url?: string;
  description: string; comments: TicketComment[]; /** `kind` is set for what a task would take along: pictures and short text. */ files: { name: string; type?: string; size?: number; kind?: 'image' | 'text' }[]; readAt: string;
};
/** A task request holds 20,000 characters; the ticket text leaves room for what the user adds. */
const REQUEST_ROOM = 18000;
const day = (at: string | undefined) => at && /^\d{4}-\d{2}-\d{2}/.test(at) ? at.slice(0, 10) : at;

/** Reads one ticket from the source the project is connected to. Reading only; nothing is written to the tool. */
export async function ticketContent(sources: TicketSources, projectId: string, source: string, key: string): Promise<{ name: string; content: TicketContent }> {
  const from = TicketSource.parse(source); const wanted = TicketKey.parse(key);
  const service = from === 'jira' ? sources.integrations : sources.trackers;
  if (!service) throw new AppError('integrations_unavailable', 'Integrations are not enabled on this service.', 503);
  return from === 'jira' ? sources.integrations!.jiraTicket(projectId, wanted) : sources.trackers!.ticket(projectId, from, wanted);
}

/**
 * The ticket as the text of a task request: number and title, the description, the comments oldest
 * first, the names of its files and the link. When everything does not fit, the oldest comments are
 * left out and counted, because the latest ones say where the ticket stands.
 */
export function ticketRequest(content: TicketContent): string {
  const head = `${content.key}: ${content.title}${content.description ? `\n\n${content.description}` : ''}`;
  const files = content.files.length ? `\n\nFiles on the ticket: ${content.files.map(file => file.name).join(', ')}` : '';
  const foot = `${files}${content.url ? `\n\nTicket: ${content.url}` : ''}`;
  const written = content.comments.map(comment => `${[comment.by, day(comment.at)].filter(Boolean).join(', ') || 'Comment'}:\n${comment.body}`);
  const kept: string[] = []; let room = REQUEST_ROOM - head.length - foot.length - 80;
  for (const comment of [...written].reverse()) { if (comment.length + 2 > room) break; kept.unshift(comment); room -= comment.length + 2; }
  const left = written.length - kept.length;
  const comments = written.length ? `\n\nComments on the ticket${left ? ` (the latest ${kept.length}; ${left} earlier ${left === 1 ? 'one is' : 'ones are'} on the ticket)` : ''}:${kept.length ? `\n\n${kept.join('\n\n')}` : ''}` : '';
  return `${head}${comments}${foot}`.slice(0, 20000);
}

export async function readTicket(sources: TicketSources, projectId: string, source: string, key: string, now: () => Date = () => new Date()): Promise<{ ticket: TicketView; request: string }> {
  const { name, content } = await ticketContent(sources, projectId, source, key);
  return {
    ticket: { source, name, ...content, files: content.files.map(({ url: _, ...file }) => { const kind = ticketFileKind(file)?.kind; return { ...file, ...(kind ? { kind } : {}) }; }), readAt: now().toISOString() },
    request: ticketRequest(content),
  };
}
