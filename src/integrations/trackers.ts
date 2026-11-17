import { randomUUID } from 'node:crypto';
import { AppError } from '../domain/errors.js';
import { connectionState, type ConnectionState, type IntegrationProblem } from '../domain/integrations.js';
import { TrackerAddInput, TrackerId, TrackerMapping, TrackerRuleInput, TrackerUpdateInput, type Tracker, type TrackerConnection, type TrackerRule, type TrackerTicket } from '../domain/trackers.js';
import type { Store } from '../persistence/store.js';
import type { SecretStore } from '../security/secret-store.js';
import type { Fetch } from './http.js';
import { McpSession, normalizeMcpUrl, type McpTool } from './mcp.js';
import { at, choice, listArguments, matches, options, sampleOf, shapeOf, suggestColumns, suggestFields, suggestList, tickets, unfilterable, type AnswerShape, type Choice, type RuleParts, type TicketSample, type TrackerOptions } from './tracker-mapping.js';

export type TrackerView = Omit<Tracker, 'savedToken'> & {
  state: ConnectionState; /** False until a mapping is saved; a project can only use a mapped tool. */ mapped: boolean;
  usedBy: { id: string; name: string }[]; /** Environment mode: the variable the token is read from. */ variable?: string;
};
export type TrackerList = { secrets: { mode: SecretStore['mode']; locked: boolean }; trackers: TrackerView[] };
export type TrackerInspection = {
  tracker: TrackerView; tools: McpTool[];
  /** A mapping proposed from the tool list and one answer. Present only when tickets were found in it. */
  suggestion?: TrackerMapping; shape?: AnswerShape; /** One real ticket, for checking the mapping against. */ sample?: TicketSample; /** Why no answer could be read, in plain words. */ note?: string;
};
export type TrackerMatches = { total: number; sample: { key: string; title: string; url?: string }[] };
export type ProjectTrackerView = { /** The tools this project uses, each with its own rule. */ connections: (TrackerConnection & { tracker: TrackerView })[]; /** Every added tool, to choose from. */ trackers: TrackerView[] };
export type TrackerServiceOptions = { fetch?: Fetch; now?: () => Date };

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const slug = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const PARTS = { project: 'project', column: 'column', assignee: 'assignee', label: 'label' } as const;

/**
 * Ticket tools that are reached through their MCP server. A tool is added once, with its address,
 * token and mapping, and each project then points at it with its own pick-up rule. Like the GitHub
 * and Jira connections this stores and checks configuration; it creates no tasks and writes nothing
 * to the tool.
 */
export class TrackerService {
  private readonly fetcher: Fetch; private readonly now: () => Date;
  constructor(private readonly store: Store, private readonly secrets: SecretStore, options: TrackerServiceOptions = {}) {
    this.fetcher = options.fetch ?? fetch; this.now = options.now ?? (() => new Date());
  }
  private stamp() { return this.now().toISOString(); }
  private usedBy(id: string) { return this.store.projects().filter(p => p.integrations?.trackers?.some(c => c.trackerId === id)).map(p => ({ id: p.id, name: p.name ?? p.id })); }
  private view(tracker: Tracker, locked: boolean): TrackerView {
    const { savedToken, ...shown } = tracker;
    return { ...shown, state: connectionState(tracker, this.now(), locked).state, mapped: Boolean(tracker.mapping), usedBy: this.usedBy(tracker.id), ...(this.secrets.mode === 'environment' ? { variable: this.secrets.variable(savedToken) } : {}) };
  }
  private required(savedToken: string): AppError {
    return new AppError('token_required', this.secrets.mode === 'vault' ? 'Paste a token to connect.' : `Set ${this.secrets.variable(savedToken)} and restart the service, then try again.`, 422);
  }
  private async session(tracker: Pick<Tracker, 'name' | 'url' | 'savedToken'>, token?: string): Promise<McpSession> {
    const value = token ?? await this.secrets.get(tracker.savedToken);
    if (!value) throw this.required(tracker.savedToken);
    return new McpSession(this.fetcher, { name: tracker.name, url: tracker.url, token: value });
  }
  private problem(error: unknown): IntegrationProblem | undefined {
    if (!(error instanceof AppError)) return;
    if (error.code === 'token_rejected' || error.code === 'not_reachable' || error.code === 'token_required') return { code: error.code === 'token_required' ? 'token_missing' : error.code, message: error.message, at: this.stamp() };
    if (error.code === 'integration_unavailable') return { code: 'not_reachable', message: error.message, at: this.stamp() };
    return;
  }
  private assertNameFree(name: string, except?: string): void {
    const taken = this.store.trackers().find(t => t.id !== except && (same(t.name, name) || t.savedToken === `tracker-${slug(name)}`));
    if (taken) throw new AppError('tracker_conflict', `A tool named "${taken.name}" already exists. Choose another name.`, 409);
  }

  async list(): Promise<TrackerList> {
    const locked = await this.secrets.locked();
    return { secrets: { mode: this.secrets.mode, locked }, trackers: this.store.trackers().map(t => this.view(t, locked)) };
  }
  async show(id: string): Promise<TrackerView> { return this.view(this.store.tracker(TrackerId.parse(id)), await this.secrets.locked()); }

  /** Signs in to the server and saves the tool. The mapping is proposed, not saved: the user confirms it. */
  async add(input: unknown): Promise<TrackerInspection> {
    const parsed = TrackerAddInput.parse(input); const url = normalizeMcpUrl(parsed.url);
    const key = slug(parsed.name);
    if (!key) throw new AppError('invalid_request', 'Use a name with at least one letter or digit.', 422);
    this.assertNameFree(parsed.name);
    const savedToken = `tracker-${key}`;
    // Environment mode refuses a pasted token here, before anything is contacted, and names the variable to set.
    if (parsed.token && this.secrets.mode === 'environment') await this.secrets.set(savedToken, parsed.token);
    const session = await this.session({ name: parsed.name, url, savedToken }, parsed.token);
    const server = await session.open();
    if (parsed.token) await this.secrets.set(savedToken, parsed.token);
    const stamp = this.stamp();
    const tracker = this.store.saveTracker({ id: randomUUID(), name: parsed.name, url, savedToken, server, connectedAt: stamp, checkedAt: stamp });
    return this.inspection(tracker, session);
  }
  /** The server's tools and a proposed mapping, for the mapping form. */
  async inspect(id: string): Promise<TrackerInspection> {
    const tracker = this.store.tracker(TrackerId.parse(id));
    return this.inspection(tracker, await this.session(tracker));
  }
  private async inspection(tracker: Tracker, session: McpSession): Promise<TrackerInspection> {
    const tools = await session.tools(); const shown = this.view(tracker, false);
    const list = tracker.mapping?.list ?? suggestList(tools);
    if (!list) return { tracker: shown, tools, note: tools.length ? 'No tool on this server looks like a ticket list. Choose one yourself.' : 'This server offers no tools to this account.' };
    let answer: unknown;
    try { answer = await session.call(list.tool, listArguments({ list } as TrackerMapping)); }
    catch (error) { if (!(error instanceof AppError)) throw error; return { tracker: shown, tools, note: error.message }; }
    const shape = shapeOf(answer); const fields = suggestFields(shape);
    if (!fields) return { tracker: shown, tools, shape, note: `The answer of ${list.tool} has no list that looks like tickets. Choose the fields yourself.` };
    const sample = sampleOf(answer, tracker.mapping?.result ?? fields.result);
    return { tracker: shown, tools, shape, ...(sample ? { sample } : {}), suggestion: TrackerMapping.parse({ list, ...fields, columns: tracker.mapping?.columns.length ? tracker.mapping.columns : suggestColumns(tools) }) };
  }
  /** Saves a mapping only after the server answered through it, so a saved mapping is one that works. */
  async setMapping(id: string, input: unknown): Promise<{ tracker: TrackerView; tickets: number }> {
    const tracker = this.store.tracker(TrackerId.parse(id)); const mapping = TrackerMapping.parse(input);
    const session = await this.session(tracker); const tool = (await session.tools()).find(t => t.name === mapping.list.tool);
    if (!tool) throw new AppError('invalid_mapping', `${tracker.name} has no tool named ${mapping.list.tool}.`, 422);
    const unknown = [...Object.keys(mapping.list.fixed), ...Object.values(mapping.list.filters).flatMap(f => f ? [f.name] : [])].filter(name => !tool.properties[name]);
    if (unknown.length) throw new AppError('invalid_mapping', `${mapping.list.tool} takes no argument named ${unknown.join(', ')}. It takes: ${Object.keys(tool.properties).join(', ') || 'none'}.`, 422);
    const answer = await session.call(mapping.list.tool, listArguments(mapping));
    const rows = at(answer, mapping.result.tickets);
    if (!Array.isArray(rows)) throw new AppError('invalid_mapping', `The answer of ${mapping.list.tool} has no list at "${mapping.result.tickets}". It has: ${shapeOf(answer).lists.map(l => l.path).join(', ') || 'no lists'}.`, 422);
    const found = tickets(mapping, answer);
    if (rows.length && !found.length) throw new AppError('invalid_mapping', `No entry of "${mapping.result.tickets}" has both "${mapping.ticket.key}" and "${mapping.ticket.title}". Check the ticket fields.`, 422);
    const account = options(mapping, answer, found).account; const { problem: _, account: __, ...rest } = tracker;
    const saved = this.store.saveTracker({ ...rest, mapping, ...(account ? { account } : {}), checkedAt: this.stamp() });
    return { tracker: this.view(saved, false), tickets: found.length };
  }
  /**
   * Edits a tool: its name, its address, its token, or any of them together. A new address or token
   * is verified by signing in before anything is saved, so a working connection is never replaced by
   * a broken one. The mapping is kept; a different server may need it corrected afterwards.
   */
  async update(id: string, input: unknown): Promise<TrackerView> {
    const tracker = this.store.tracker(TrackerId.parse(id)); const parsed = TrackerUpdateInput.parse(input);
    let next = tracker;
    if (parsed.name !== undefined && parsed.name !== tracker.name) { this.assertNameFree(parsed.name, tracker.id); next = { ...next, name: parsed.name }; }
    const url = parsed.url === undefined ? tracker.url : normalizeMcpUrl(parsed.url);
    if (url !== tracker.url || parsed.token !== undefined) {
      if (parsed.token !== undefined && this.secrets.mode === 'environment') await this.secrets.set(tracker.savedToken, parsed.token);
      const session = await this.session({ ...next, url }, parsed.token); const server = await session.open();
      // With a mapping the list tool must answer at the new address too; otherwise the edit would silently break every project's rule.
      if (next.mapping && url !== tracker.url) await session.call(next.mapping.list.tool, listArguments(next.mapping));
      if (parsed.token !== undefined) await this.secrets.set(tracker.savedToken, parsed.token);
      const { problem: _, ...rest } = next; next = { ...rest, url, server, checkedAt: this.stamp() };
    }
    return this.view(this.store.saveTracker(next), await this.secrets.locked());
  }
  async check(id: string): Promise<TrackerView> {
    const tracker = this.store.tracker(TrackerId.parse(id)); let update: Tracker;
    try {
      const session = await this.session(tracker); const server = await session.open();
      // With a mapping the check also proves that the list tool still answers.
      if (tracker.mapping) await session.call(tracker.mapping.list.tool, listArguments(tracker.mapping));
      const { problem: _, ...rest } = tracker; update = { ...rest, server, checkedAt: this.stamp() };
    } catch (error) {
      const problem = this.problem(error); if (!problem) throw error;
      update = { ...tracker, problem, checkedAt: problem.at };
    }
    return this.view(this.store.saveTracker(update), await this.secrets.locked());
  }
  /** Removes a tool and forgets its token. Refused while a project still points at it. */
  async remove(id: string): Promise<TrackerList> {
    const tracker = this.store.tracker(TrackerId.parse(id)); const users = this.usedBy(tracker.id);
    if (users.length) throw new AppError('tracker_in_use', `${tracker.name} is used by ${users.map(u => u.name).join(', ')}. Disconnect it there first.`, 409);
    this.store.removeTracker(tracker.id); await this.secrets.remove(tracker.savedToken);
    return this.list();
  }

  // A project's use of tools. A project may use several; each connection has its own rule.
  async projectView(projectId: string): Promise<ProjectTrackerView> {
    const connections = this.store.project(projectId).integrations?.trackers ?? []; const { trackers } = await this.list();
    return { connections: connections.flatMap(c => { const tracker = trackers.find(t => t.id === c.trackerId); return tracker ? [{ ...c, tracker }] : []; }), trackers };
  }
  /** Uses an added tool for this project. The tool's address and token are already saved, so nothing is entered again. */
  async connect(projectId: string, trackerId: string): Promise<ProjectTrackerView> {
    const project = this.store.project(projectId);
    if (project.archivedAt) throw new AppError('project_archived', 'This project is archived. Restore it before connecting it.', 409);
    const tracker = this.store.tracker(TrackerId.parse(trackerId));
    if (!tracker.mapping) throw new AppError('tracker_unmapped', `${tracker.name} has no mapping yet. Finish adding the tool first.`, 409);
    this.store.setProjectIntegrations(projectId, all => (all.trackers ?? []).some(c => c.trackerId === tracker.id) ? all : { ...all, trackers: [...(all.trackers ?? []), { trackerId: tracker.id, connectedAt: this.stamp() }] });
    return this.projectView(projectId);
  }
  /** Stops using one tool for this project, or every tool when none is named. The tools themselves stay. */
  async disconnect(projectId: string, trackerId?: string): Promise<ProjectTrackerView> {
    const id = trackerId === undefined ? undefined : TrackerId.parse(trackerId);
    this.store.setProjectIntegrations(projectId, current => {
      const { trackers = [], ...rest } = current; const kept = id ? trackers.filter(c => c.trackerId !== id) : [];
      return kept.length ? { ...rest, trackers: kept } : rest;
    });
    return this.projectView(projectId);
  }
  private async load(projectId: string, trackerId: string): Promise<{ tracker: Tracker; mapping: TrackerMapping; session: McpSession }> {
    const id = TrackerId.parse(trackerId);
    if (!this.store.project(projectId).integrations?.trackers?.some(c => c.trackerId === id)) throw new AppError('not_connected', 'This tool is not connected for this project', 404);
    const tracker = this.store.tracker(id);
    if (!tracker.mapping) throw new AppError('tracker_unmapped', `${tracker.name} has no mapping yet. Finish adding the tool first.`, 409);
    return { tracker, mapping: tracker.mapping, session: await this.session(tracker) };
  }
  private async everything(mapping: TrackerMapping, session: McpSession): Promise<{ found: TrackerTicket[]; options: TrackerOptions }> {
    const answer = await session.call(mapping.list.tool, listArguments(mapping)); const found = tickets(mapping, answer);
    return { found, options: options(mapping, answer, found) };
  }
  /** Projects, columns, people and labels a rule can name. */
  async choices(projectId: string, trackerId: string): Promise<Omit<TrackerOptions, 'projects' | 'people'> & { projects: { id: string; name: string }[]; people: { id: string; name: string }[]; filters: (keyof RuleParts)[] }> {
    const { mapping, session } = await this.load(projectId, trackerId); const { options: all } = await this.everything(mapping, session);
    const plain = (entries: Choice[]) => entries.map(({ id, name }) => ({ id, name }));
    const fields: Record<keyof RuleParts, string | undefined> = { project: mapping.ticket.project, column: mapping.ticket.column, assignee: mapping.ticket.assignee, label: mapping.ticket.labels };
    // Only the filters this tool can answer are offered, so a rule never names something that cannot be checked.
    const filters = (Object.keys(PARTS) as (keyof RuleParts)[]).filter(part => mapping.list.filters[part] || fields[part]);
    return { ...all, projects: plain(all.projects), people: plain(all.people), filters };
  }
  private async resolve(projectId: string, trackerId: string, input: unknown): Promise<{ rule: TrackerRule; matches: TrackerMatches }> {
    const parsed = TrackerRuleInput.parse(input); const { tracker, mapping, session } = await this.load(projectId, trackerId);
    const { options: all } = await this.everything(mapping, session);
    const named = (what: string, entries: Choice[], value: string): Choice => {
      const hit = entries.find(e => e.id === value) ?? entries.find(e => same(e.name, value)) ?? entries.find(e => e.match.includes(value.trim().toLowerCase()));
      if (hit) return hit;
      // A tool that lists none is taken at its word; one that lists some must know the name.
      if (!entries.length) return choice(value)!;
      throw new AppError('invalid_rule', `${tracker.name} has no ${what} "${value}". Available: ${entries.slice(0, 20).map(e => e.name).join(', ')}.`, 422);
    };
    const parts: RuleParts = {};
    if (parsed.project !== undefined) parts.project = named('project', all.projects, parsed.project);
    if (parsed.column !== undefined) {
      const column = all.columns.find(c => same(c, parsed.column!));
      if (!column && all.columns.length) throw new AppError('invalid_rule', `${tracker.name} has no column "${parsed.column}". Available: ${all.columns.join(', ')}.`, 422);
      parts.column = column ?? parsed.column;
    }
    if (parsed.assignee !== undefined) parts.assignee = named('person', all.people, parsed.assignee);
    if (parsed.label !== undefined) parts.label = all.labels.find(l => same(l, parsed.label!)) ?? parsed.label.trim();
    const blind = unfilterable(mapping, parts);
    if (blind.length) throw new AppError('invalid_rule', `${tracker.name} is not mapped to filter by ${blind.join(' or ')}. Add the argument or the ticket field to its mapping.`, 422);
    const hits = tickets(mapping, await session.call(mapping.list.tool, listArguments(mapping, parts))).filter(ticket => matches(mapping, ticket, parts));
    return {
      rule: { ...parts, start: parsed.start, savedAt: this.stamp() },
      matches: { total: hits.length, sample: hits.slice(0, 5).map(({ key, title, url }) => ({ key, title, ...(url ? { url } : {}) })) },
    };
  }
  /** What a rule would match right now, without saving it. */
  async preview(projectId: string, trackerId: string, input: unknown): Promise<{ rule: TrackerRule; matches: TrackerMatches }> { return this.resolve(projectId, trackerId, input); }
  /** Saves a rule only after the tool answered its search. */
  async saveRule(projectId: string, trackerId: string, input: unknown): Promise<ProjectTrackerView & { matches: TrackerMatches }> {
    const { rule, matches: found } = await this.resolve(projectId, trackerId, input);
    this.store.setProjectIntegrations(projectId, current => {
      if (!current.trackers?.some(c => c.trackerId === trackerId)) throw new AppError('not_connected', 'This tool is not connected for this project', 404);
      return { ...current, trackers: current.trackers.map(c => c.trackerId === trackerId ? { ...c, rule } : c) };
    });
    return { ...await this.projectView(projectId), matches: found };
  }
}
