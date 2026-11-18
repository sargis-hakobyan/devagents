import { TICKET_LIMITS, type TicketComment, type TicketContent, type TicketFile } from '../domain/tickets.js';
import type { TrackerChoice, TrackerMapping, TrackerTicket } from '../domain/trackers.js';
import { list, record, text } from './http.js';
import type { McpTool } from './mcp.js';

/**
 * Reads a tool's answer through a mapping, and proposes a mapping from what a server declares and
 * returns. Nothing here knows a particular tool. Answers are remote content: only mapped fields are
 * read, as short plain text.
 */
const MAX_TICKETS = 2000; const MAX_CHOICES = 500;
const fold = (value: string) => value.trim().toLowerCase();

export function at(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split('.')) { if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined; current = (current as Record<string, unknown>)[part]; }
  return current;
}
const scalar = (value: unknown, limit = 200): string => typeof value === 'number' && Number.isFinite(value) ? String(value) : text(value, limit);
const ID_FIELDS = ['id', 'key', 'email', 'accountId', 'login', 'slug', 'name'] as const;
const NAME_FIELDS = ['name', 'displayName', 'title', 'label', 'email', 'login', 'key'] as const;
/** Something a rule can name: a plain value, or an object with an id and a name. `match` holds every way a ticket may refer to it. */
export type Choice = Required<TrackerChoice>;
export function choice(value: unknown): Choice | undefined {
  const plain = scalar(value);
  if (plain) return { id: plain, name: plain, match: [fold(plain)] };
  const item = record(value);
  const id = ID_FIELDS.map(f => scalar(item[f])).find(Boolean); if (!id) return;
  const name = NAME_FIELDS.map(f => scalar(item[f])).find(Boolean) ?? id;
  return { id, name, match: [...new Set([...ID_FIELDS, ...NAME_FIELDS].map(f => fold(scalar(item[f]))).filter(Boolean))] };
}
const choices = (value: unknown): Choice[] => {
  const seen = new Set<string>(); const found: Choice[] = [];
  for (const item of list(value)) { const c = choice(item); if (c && !seen.has(c.id) && found.length < MAX_CHOICES) { seen.add(c.id); found.push(c); } }
  return found;
};
/** The value a ticket carries for a project or person: the plain value, or the object's id. */
const reference = (value: unknown): string | undefined => choice(value)?.id;
const link = (value: unknown): string | undefined => { const url = scalar(value, 500); return /^https?:\/\/[^\s]+$/.test(url) ? url : undefined; };

export function tickets(mapping: TrackerMapping, answer: unknown): TrackerTicket[] {
  const found: TrackerTicket[] = [];
  for (const item of list(at(answer, mapping.result.tickets)).slice(0, MAX_TICKETS)) {
    const key = scalar(at(item, mapping.ticket.key)); const title = scalar(at(item, mapping.ticket.title), 300);
    if (!key || !title) continue;
    const field = (path: string | undefined) => path ? at(item, path) : undefined;
    const column = scalar(field(mapping.ticket.column)); const project = reference(field(mapping.ticket.project)); const assignee = reference(field(mapping.ticket.assignee));
    const url = link(field(mapping.ticket.url));
    found.push({
      key, title, labels: list(field(mapping.ticket.labels)).map(l => choice(l)?.name).filter((l): l is string => Boolean(l)).slice(0, 100),
      ...(column ? { column } : {}), ...(project ? { project } : {}), ...(assignee ? { assignee } : {}), ...(url ? { url } : {}),
    });
  }
  return found;
}

export type TrackerOptions = { projects: Choice[]; columns: string[]; people: Choice[]; labels: string[]; account?: string };
/** What a rule can name, from one answer of the list tool. */
export function options(mapping: TrackerMapping, answer: unknown, found: TrackerTicket[]): TrackerOptions {
  const pick = (path: string | undefined) => path ? choices(at(answer, path)) : [];
  const account = mapping.result.account ? choice(at(answer, mapping.result.account)) : undefined;
  const unique = (values: (string | undefined)[]) => [...new Map(values.filter((v): v is string => Boolean(v)).map(v => [fold(v), v])).values()];
  return {
    projects: pick(mapping.result.projects), people: pick(mapping.result.people),
    columns: mapping.columns.length ? mapping.columns : unique(found.map(t => t.column)),
    // Labels that are on tickets count too: a tool may let integrations tag tickets with labels it does not list.
    labels: unique([...pick(mapping.result.labels).map(l => l.name), ...found.flatMap(t => t.labels)]).sort((a, b) => a.localeCompare(b)).slice(0, MAX_CHOICES),
    ...(account ? { account: account.name === account.id ? account.id : `${account.name} (${account.id})` } : {}),
  };
}

export type RuleParts = { projects?: Choice[]; columns?: string[]; assignees?: Choice[]; labels?: string[] };
type Part = 'project' | 'column' | 'assignee' | 'label';
const wanted = (rule: RuleParts): Record<Part, string[]> => ({ project: (rule.projects ?? []).map(p => p.id), column: rule.columns ?? [], assignee: (rule.assignees ?? []).map(a => a.id), label: rule.labels ?? [] });
/**
 * Which rule parts the tool filters by itself. One value is always safe to send. Several values are
 * sent only for the column, where a list means "any of these" in every tool; for the other parts a
 * tool may mean "all of these", so DevAgents filters them on the returned tickets.
 */
function sent(mapping: TrackerMapping, rule: RuleParts): Partial<Record<Part, unknown>> {
  const out: Partial<Record<Part, unknown>> = {}; const values = wanted(rule);
  for (const part of Object.keys(values) as Part[]) {
    const filter = mapping.list.filters[part]; const chosen = values[part];
    if (!filter || !chosen.length) continue;
    if (chosen.length === 1) out[part] = filter.many ? chosen : chosen[0];
    else if (part === 'column' && filter.many) out[part] = chosen;
  }
  return out;
}
/** Arguments for the list tool: the fixed ones, plus every rule value the server can filter by itself. */
export function listArguments(mapping: TrackerMapping, rule: RuleParts = {}): Record<string, unknown> {
  const args: Record<string, unknown> = { ...mapping.list.fixed };
  for (const [part, value] of Object.entries(sent(mapping, rule))) args[mapping.list.filters[part as Part]!.name] = value;
  return args;
}
/** Rule parts that neither the server filters nor a ticket field can answer. */
export function unfilterable(mapping: TrackerMapping, rule: RuleParts): Part[] {
  const fields: Record<Part, string | undefined> = { project: mapping.ticket.project, column: mapping.ticket.column, assignee: mapping.ticket.assignee, label: mapping.ticket.labels };
  const served = sent(mapping, rule); const values = wanted(rule);
  return (Object.keys(fields) as Part[]).filter(part => values[part].length > 0 && !(part in served) && !fields[part]);
}
/** The same rule applied to the returned tickets, wherever the ticket field is mapped. It also covers what the server did not filter. */
export function matches(mapping: TrackerMapping, ticket: TrackerTicket, rule: RuleParts): boolean {
  const any = <T>(values: T[] | undefined, test: (value: T) => boolean) => !values?.length || values.some(test);
  if (mapping.ticket.project && !any(rule.projects, p => Boolean(ticket.project) && p.match.includes(fold(ticket.project!)))) return false;
  if (mapping.ticket.column && !any(rule.columns, c => fold(ticket.column ?? '') === fold(c))) return false;
  if (mapping.ticket.assignee && !any(rule.assignees, a => Boolean(ticket.assignee) && a.match.includes(fold(ticket.assignee!)))) return false;
  if (mapping.ticket.labels && !any(rule.labels, l => ticket.labels.some(have => fold(have) === fold(l)))) return false;
  return true;
}

// Suggestions. They are a starting point the user confirms, so a wrong guess costs one correction.
const first = (names: string[], patterns: RegExp[]) => { for (const pattern of patterns) { const hit = names.find(n => pattern.test(n)); if (hit) return hit; } return; };
const TICKET_WORD = /task|ticket|issue|work|item|card|stor/i;

/** The tool that most looks like "list tickets", with the arguments a rule can use. */
export function suggestList(tools: McpTool[]): TrackerMapping['list'] | undefined {
  const score = (tool: McpTool) => (/(^|[_.\-/])(list|search|find|query)/i.test(tool.name) ? 2 : 0) + (TICKET_WORD.test(tool.name) ? 2 : 0) - (/get|create|update|delete|add|remove|comment/i.test(tool.name) ? 3 : 0);
  const best = [...tools].sort((a, b) => score(b) - score(a))[0];
  if (!best || score(best) < 2) return;
  const names = Object.keys(best.properties);
  const filter = (patterns: RegExp[]) => { const name = first(names.filter(n => !best.properties[n]!.choices.length), patterns); return name ? { name, many: best.properties[name]!.many } : undefined; };
  const project = filter([/^project(_?id|_?key)?$/i, /project/i, /board|team|space/i]); const column = filter([/^status(es)?$/i, /^states?$/i, /status|state|column|stage/i]);
  const label = filter([/^labels?$/i, /label|tag/i]); const assignee = filter([/^assignee/i, /assignee|owner/i]);
  // A tool that defaults to the caller's own tickets usually offers "all" on the same argument.
  const fixed = Object.fromEntries(names.filter(n => best.properties[n]!.choices.includes('all')).map(n => [n, 'all']));
  return { tool: best.name, fixed, filters: { ...(project ? { project } : {}), ...(column ? { column } : {}), ...(label ? { label } : {}), ...(assignee ? { assignee } : {}) } };
}
/** The tool that most looks like "return one ticket", with the argument that takes the ticket number. */
export function suggestRead(tools: McpTool[]): NonNullable<TrackerMapping['read']> | undefined {
  const score = (tool: McpTool) => (/(^|[_.\-/])(get|read|show|fetch|view)/i.test(tool.name) ? 2 : 0) + (TICKET_WORD.test(tool.name) ? 2 : 0) - (/list|search|find|query|create|update|delete|add|remove|comment|check/i.test(tool.name) ? 3 : 0);
  for (const tool of [...tools].filter(t => score(t) >= 3).sort((a, b) => score(b) - score(a))) {
    const single = Object.keys(tool.properties).filter(n => !tool.properties[n]!.many);
    const key = first(single, [/^(task|ticket|issue|item|card|work_?item)?_?(id|key|number)$/i, /(id|key|number)$/i]) ?? (single.length === 1 ? single[0] : undefined);
    if (key) return { tool: tool.name, key };
  }
  return;
}
/** The tool that can hand a ticket to a person: one that updates a ticket and takes an assignee. */
export function suggestAssign(tools: McpTool[]): NonNullable<TrackerMapping['assign']> | undefined {
  const score = (tool: McpTool) => (/(^|[_.\-/])(update|edit|assign|patch|set|modify)/i.test(tool.name) ? 2 : 0) + (TICKET_WORD.test(tool.name) ? 2 : 0) - (/list|search|find|query|create|delete|remove|comment|check/i.test(tool.name) ? 3 : 0);
  for (const tool of [...tools].filter(t => score(t) >= 3).sort((a, b) => score(b) - score(a))) {
    const single = Object.keys(tool.properties).filter(n => !tool.properties[n]!.many);
    const assignee = first(single, [/^assignee(_?id)?$/i, /^assigned_?to$/i, /^owner(_?id)?$/i]);
    const key = first(single.filter(n => n !== assignee), [/^(task|ticket|issue|item|card|work_?item)?_?(id|key|number)$/i]);
    const operation = first(single, [/^(operation|idempotency|request)_?(id|key)$/i]);
    if (assignee && key) return { tool: tool.name, key, assignee, ...(operation && operation !== key ? { operation } : {}) };
  }
  return;
}

/** Text of a ticket keeps its lines; control characters are dropped. */
const prose = (value: unknown, limit: number): string => typeof value === 'string' ? value.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/[^\S\n]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, limit) : '';
const firstOf = <T>(item: Record<string, unknown>, fields: readonly string[], read: (value: unknown) => T | undefined): T | undefined => { for (const field of fields) { const value = read(item[field]); if (value !== undefined && value !== '') return value; } return; };
/**
 * One ticket from the answer of the read tool. The number, title and link are where the mapping says
 * they are on a listed ticket; the text, comments and files are found by their usual names, because a
 * tool that returns one ticket rarely needs more than that.
 */
export function ticketContent(mapping: TrackerMapping, answer: unknown): TicketContent | undefined {
  const whole = record(answer);
  const root = [whole, ...['task', 'ticket', 'issue', 'item', 'card', 'data', 'result'].map(name => record(whole[name]))].find(item => scalar(at(item, mapping.ticket.key)) && scalar(at(item, mapping.ticket.title), 300));
  if (!root) return;
  const url = mapping.ticket.url ? link(at(root, mapping.ticket.url)) : undefined;
  const comments: TicketComment[] = [];
  for (const entry of list(firstOf(root, ['comments', 'notes'], value => Array.isArray(value) ? value : undefined)).map(record)) {
    const body = firstOf(entry, ['body', 'text', 'content', 'comment', 'message'], value => prose(value, TICKET_LIMITS.comment)); if (!body) continue;
    const by = firstOf(entry, ['by', 'author', 'createdBy', 'user', 'authorName'], value => choice(value)?.name); const when = firstOf(entry, ['createdAt', 'created', 'at', 'date', 'timestamp'], value => scalar(value, 40));
    comments.push({ body, ...(by ? { by } : {}), ...(when ? { at: when } : {}) });
  }
  const files: TicketFile[] = [];
  for (const entry of list(firstOf(root, ['attachments', 'files'], value => Array.isArray(value) ? value : undefined)).map(record).slice(0, TICKET_LIMITS.files)) {
    const name = firstOf(entry, ['name', 'filename', 'fileName', 'title'], value => scalar(value, 200)); if (!name) continue;
    const source = firstOf(entry, ['url', 'downloadUrl', 'download_url', 'href', 'link'], link); const type = firstOf(entry, ['type', 'mimeType', 'contentType', 'mime'], value => scalar(value, 100));
    const size = firstOf(entry, ['size', 'bytes'], value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined);
    files.push({ name, ...(type ? { type } : {}), ...(size !== undefined ? { size } : {}), ...(source ? { url: source } : {}) });
  }
  return {
    key: scalar(at(root, mapping.ticket.key)), title: scalar(at(root, mapping.ticket.title), 300), ...(url ? { url } : {}),
    description: firstOf(root, ['description', 'body', 'content', 'text', 'details'], value => prose(value, TICKET_LIMITS.description)) ?? '',
    comments: comments.slice(-TICKET_LIMITS.comments), files,
  };
}

/** Columns a server declares as the allowed values of a status-like argument on any of its tools. */
export function suggestColumns(tools: McpTool[]): string[] {
  const found = tools.flatMap(tool => Object.entries(tool.properties).filter(([name, p]) => /^(status|state|column|stage)(es|s)?$/i.test(name) && p.choices.length > 1).map(([, p]) => p.choices));
  return found.sort((a, b) => b.length - a.length)[0] ?? [];
}

export type AnswerShape = { /** Lists in the answer, with the field names of their entries. */ lists: { path: string; fields: string[] }[]; /** Single values and objects. */ values: string[] };
/** The outline of an answer, two levels deep, for choosing paths. It carries field names only, never values. */
export function shapeOf(answer: unknown): AnswerShape {
  const lists: AnswerShape['lists'] = []; const values: string[] = [];
  const walk = (value: unknown, path: string, depth: number) => {
    for (const [key, child] of Object.entries(record(value)).slice(0, 60)) {
      if (!/^[A-Za-z0-9_$-]+$/.test(key)) continue;
      const here = path ? `${path}.${key}` : key;
      if (Array.isArray(child)) lists.push({ path: here, fields: fieldsOf(child[0]) });
      else { values.push(here); if (depth < 2) walk(child, here, depth + 1); }
    }
  };
  walk(answer, '', 0);
  return { lists: lists.slice(0, 40), values: values.slice(0, 80) };
}
function fieldsOf(entry: unknown): string[] {
  const found: string[] = [];
  for (const [key, child] of Object.entries(record(entry)).slice(0, 60)) {
    if (!/^[A-Za-z0-9_$-]+$/.test(key)) continue;
    found.push(key);
    // One level into objects, so a field such as assignee.email can be chosen.
    if (child && typeof child === 'object' && !Array.isArray(child)) for (const inner of Object.keys(child).slice(0, 20)) if (/^[A-Za-z0-9_$-]+$/.test(inner)) found.push(`${key}.${inner}`);
  }
  return found.slice(0, 120);
}
export type TicketSample = { /** Field path → its value on the first ticket, as short plain text. */ values: Record<string, string>; /** Ids, keys and emails of projects and people → their names, so an id can be shown as a name. */ names: Record<string, string> };
/**
 * The first ticket of an answer, field by field, so the person confirming a mapping sees real values
 * next to field names. It goes only to the signed-in owner who added the tool, as plain text.
 */
export function sampleOf(answer: unknown, result: { tickets: string; projects?: string | undefined; people?: string | undefined }): TicketSample | undefined {
  const first = list(at(answer, result.tickets))[0]; if (!first) return;
  const values: Record<string, string> = {};
  for (const field of fieldsOf(first)) {
    const value = at(first, field);
    const shown = Array.isArray(value) ? value.map(v => choice(v)?.name).filter(Boolean).slice(0, 6).join(', ') : scalar(value, 120) || (choice(value)?.name ?? '');
    if (shown) values[field] = shown;
  }
  const names: Record<string, string> = {};
  for (const path of [result.projects, result.people]) for (const entry of path ? choices(at(answer, path)) : []) for (const key of entry.match) names[key] = entry.name;
  return { values, names };
}
/** Where the tickets and their fields most likely are in an answer. */
export function suggestFields(shape: AnswerShape): Pick<TrackerMapping, 'result' | 'ticket'> | undefined {
  const leaf = (path: string) => path.split('.').at(-1)!;
  const ticketLike = (entry: AnswerShape['lists'][number]) => first(entry.fields, [/^(key|identifier|number|id)$/i]) && first(entry.fields, [/^(title|summary|subject|name)$/i]);
  const candidates = shape.lists.filter(ticketLike).sort((a, b) => Number(TICKET_WORD.test(leaf(b.path)) || /result|data/i.test(leaf(b.path))) - Number(TICKET_WORD.test(leaf(a.path)) || /result|data/i.test(leaf(a.path))) || Number(Boolean(first(b.fields, [/^(status|state)$/i]))) - Number(Boolean(first(a.fields, [/^(status|state)$/i]))));
  const found = candidates[0]; if (!found) return;
  const other = (patterns: RegExp[]) => first(shape.lists.filter(l => l.path !== found.path).map(l => l.path), patterns.map(p => new RegExp(`(^|\\.)${p.source}$`, 'i')));
  const field = (patterns: RegExp[]) => first(found.fields, patterns);
  const projects = other([/projects?/, /boards?/, /teams?/]); const labels = other([/labels?/, /tags?/]); const people = other([/users?/, /members?/, /people/, /assignees?/]);
  const account = first(shape.values, [/(^|\.)viewer$/i, /(^|\.)(me|account|currentUser)$/i]);
  const column = field([/^status$/i, /^state$/i, /^column$/i, /^stage$/i]); const project = field([/^project(_?id|_?key)$/i, /^project$/i, /^project\.id$/i]);
  const assignee = field([/^assignee(_?email|_?id)?$/i, /^assignee\.(email|id)$/i, /^owner$/i]); const ticketLabels = field([/^labels$/i, /^tags$/i]);
  const url = field([/^url$/i, /^(web_?url|html_url|link|permalink)$/i]);
  return {
    result: { tickets: found.path, ...(projects ? { projects } : {}), ...(labels ? { labels } : {}), ...(people ? { people } : {}), ...(account ? { account } : {}) },
    ticket: {
      key: field([/^key$/i, /^identifier$/i, /^number$/i, /^id$/i])!, title: field([/^title$/i, /^summary$/i, /^subject$/i, /^name$/i])!,
      ...(column ? { column } : {}), ...(project ? { project } : {}), ...(assignee ? { assignee } : {}), ...(ticketLabels ? { labels: ticketLabels } : {}), ...(url ? { url } : {}),
    },
  };
}
