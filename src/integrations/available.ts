import { AppError } from '../domain/errors.js';
import type { Store } from '../persistence/store.js';
import type { ProjectIntegrationService } from './service.js';
import type { TrackerService } from './trackers.js';

/** A ticket that matches a project's pick-up rule and has no task yet. It is a ticket, not a task. */
export type AvailableTicket = {
  source: { kind: 'jira' | 'tool'; name: string }; key: string; title: string; url?: string;
  projectId: string; projectName: string; /** The rule values it matched, for example "todo · label devagents". */ why: string; start: 'manual' | 'auto';
};
export type AvailableTickets = { tickets: AvailableTicket[]; /** Sources that could not be read; the others are still listed. */ problems: { projectName: string; source: string; message: string }[]; checkedAt: string };

const PER_SOURCE = 50; const RECENT_TASKS = 200;
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The tickets that every active project's rules match right now, for the Available column of the
 * task board. Reading only: nothing is started and nothing is written to a ticket tool.
 *
 * A ticket counts as started when a task of the same project names its key in the request, which is
 * what "Start task" puts there. Tasks carry no ticket reference of their own yet.
 */
export async function availableTickets(store: Store, sources: { integrations?: ProjectIntegrationService | undefined; trackers?: TrackerService | undefined }, now: () => Date = () => new Date()): Promise<AvailableTickets> {
  const tickets: AvailableTicket[] = []; const problems: AvailableTickets['problems'] = [];
  for (const project of store.projects()) {
    if (project.archivedAt) continue;
    const projectName = project.name ?? project.id; const found: AvailableTicket[] = [];
    const read = async (source: string, load: () => Promise<Omit<AvailableTicket, 'projectId' | 'projectName'>[]>) => {
      try { for (const ticket of (await load()).slice(0, PER_SOURCE)) found.push({ ...ticket, projectId: project.id, projectName }); }
      catch (error) { if (!(error instanceof AppError)) throw error; problems.push({ projectName, source, message: error.message }); }
    };
    if (sources.integrations && project.integrations?.jira?.rule) await read('Jira', () => sources.integrations!.jiraTickets(project.id));
    for (const connection of sources.trackers && project.integrations?.trackers?.filter(c => c.rule) || []) {
      const name = store.trackers().find(t => t.id === connection.trackerId)?.name ?? 'Ticket tool';
      await read(name, () => sources.trackers!.ruleTickets(project.id, connection.trackerId));
    }
    if (!found.length) continue;
    const requests = store.summaries({ projectId: project.id, limit: RECENT_TASKS }).tasks.map(task => task.request);
    const started = (key: string) => { const pattern = new RegExp(`(^|[^A-Za-z0-9])${escape(key)}([^A-Za-z0-9]|$)`, 'i'); return requests.some(request => pattern.test(request)); };
    tickets.push(...found.filter(ticket => !started(ticket.key)));
  }
  return { tickets, problems, checkedAt: now().toISOString() };
}
