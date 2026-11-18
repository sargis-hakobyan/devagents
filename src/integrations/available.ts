import { AppError } from '../domain/errors.js';
import type { Store } from '../persistence/store.js';
import type { ProjectIntegrationService } from './service.js';
import type { TrackerService } from './trackers.js';

/** A ticket that matches a project's pick-up rule and has no live task. It is a ticket, not a task. */
export type AvailableTicket = {
  source: { kind: 'jira' | 'tool'; name: string; /** `jira`, or the ID of the ticket tool. */ id: string }; key: string; title: string; url?: string;
  projectId: string; projectName: string; /** The rule values it matched, for example "todo · label devagents". */ why: string; start: 'manual' | 'auto';
};
export type AvailableTickets = { tickets: AvailableTicket[]; /** Sources that could not be read; the others are still listed. */ problems: { projectName: string; source: string; message: string }[]; checkedAt: string };

const PER_SOURCE = 50; const RECENT_TASKS = 200;
/** A task that left nothing behind for its ticket: it failed, was cancelled, or its pull request was closed unmerged. */
const abandoned = (task: { state: string; pullRequest?: { state: string } | undefined }) => task.state === 'failed' || task.state === 'cancelled' || task.pullRequest?.state === 'closed';
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The tickets that every active project's rules match right now, for the Available column of the
 * task board. Reading only: nothing is started and nothing is written to a ticket tool.
 *
 * A ticket counts as started while a task of the same project that was started from it is still
 * alive: waiting, working, or completed. It is available again when every such task ended without a
 * result (failed or cancelled), or its pull request was closed without merging, so a ticket that is
 * put back on the board can be started again. Tasks from before tasks recorded their ticket are
 * recognised by the ticket number in their request.
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
    const tasks = store.summaries({ projectId: project.id, limit: RECENT_TASKS }).tasks;
    const started = (ticket: AvailableTicket) => {
      const pattern = new RegExp(`(^|[^A-Za-z0-9])${escape(ticket.key)}([^A-Za-z0-9]|$)`, 'i');
      // A fix round names its pull request's ticket in its title but is not a task of that ticket; the task that owns the pull request decides.
      return tasks.some(task => !task.roundOf && !abandoned(task) && (task.ticket ? task.ticket.source === ticket.source.id && task.ticket.key.toLowerCase() === ticket.key.toLowerCase() : pattern.test(task.request)));
    };
    tickets.push(...found.filter(ticket => !started(ticket)));
  }
  return { tickets, problems, checkedAt: now().toISOString() };
}
