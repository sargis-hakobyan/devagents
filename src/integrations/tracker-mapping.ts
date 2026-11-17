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

export type RuleParts = { project?: Choice; column?: string; assignee?: Choice; label?: string };
/** Arguments for the list tool: the fixed ones, plus every rule value the server can filter by itself. */
export function listArguments(mapping: TrackerMapping, rule: RuleParts = {}): Record<string, unknown> {
  const args: Record<string, unknown> = { ...mapping.list.fixed };
  const put = (filter: { name: string; many: boolean } | undefined, value: string | undefined) => { if (filter && value) args[filter.name] = filter.many ? [value] : value; };
  put(mapping.list.filters.project, rule.project?.id); put(mapping.list.filters.column, rule.column);
  put(mapping.list.filters.label, rule.label); put(mapping.list.filters.assignee, rule.assignee?.id);
  return args;
}
/** Rule parts that neither the server filters nor a ticket field can answer. */
export function unfilterable(mapping: TrackerMapping, rule: RuleParts): string[] {
  const fields: Record<keyof RuleParts, string | undefined> = { project: mapping.ticket.project, column: mapping.ticket.column, assignee: mapping.ticket.assignee, label: mapping.ticket.labels };
  return (Object.keys(fields) as (keyof RuleParts)[]).filter(part => rule[part] !== undefined && !mapping.list.filters[part] && !fields[part]);
}
/** The same rule applied to the returned tickets, wherever the ticket field is mapped. It also covers what the server did not filter. */
export function matches(mapping: TrackerMapping, ticket: TrackerTicket, rule: RuleParts): boolean {
  if (rule.project && mapping.ticket.project && !(ticket.project && rule.project.match.includes(fold(ticket.project)))) return false;
  if (rule.column && mapping.ticket.column && fold(ticket.column ?? '') !== fold(rule.column)) return false;
  if (rule.assignee && mapping.ticket.assignee && !(ticket.assignee && rule.assignee.match.includes(fold(ticket.assignee)))) return false;
  if (rule.label && mapping.ticket.labels && !ticket.labels.some(l => fold(l) === fold(rule.label!))) return false;
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
