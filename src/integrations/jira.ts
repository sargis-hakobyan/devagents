import { AppError } from '../domain/errors.js';
import type { JiraIntegration, JiraRule } from '../domain/integrations.js';
import { list, record, remote, text, type Fetch, type RemoteResponse } from './http.js';

export type JiraAccess = Pick<JiraIntegration, 'kind' | 'site' | 'email' | 'gateway'> & { token: string };
export type JiraColumn = { name: string; statusIds: string[] };
export type JiraUser = { id: string; name: string };
export type JiraOptions = { columns: JiraColumn[]; columnsFrom: 'board' | 'statuses'; users: JiraUser[]; labels: string[] };
export type JiraMatches = { count: number | null; keys: string[] };
/** One row of a type-ahead list. `id` is what a rule stores; `name` is what a person reads. */
export type JiraSuggestion = { id: string; name: string };
export const SUGGESTION_LIMIT = 20;

/** `example.atlassian.net` or a full address becomes an https base without a trailing slash. A self-hosted context path is kept. */
export function normalizeSite(input: string): string {
  const raw = input.trim(); let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`); }
  catch { throw new AppError('invalid_site', 'Enter the Jira address, for example example.atlassian.net'); }
  if (url.protocol !== 'https:') throw new AppError('invalid_site', 'The Jira address must use https, so the token is never sent unencrypted');
  if (url.username || url.password || url.search || url.hash) throw new AppError('invalid_site', 'Enter only the Jira address, without a user name, query or fragment');
  if (!url.hostname.includes('.')) throw new AppError('invalid_site', 'Enter the full Jira host name, for example example.atlassian.net');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}
const quote = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
/** The saved rule as JQL. Without a column, finished tickets are excluded so a label or assignee alone stays about open work. */
export function ruleJql(rule: Pick<JiraRule, 'project' | 'column' | 'assignee' | 'label'>): string {
  const parts = [`project = ${quote(rule.project.key)}`];
  if (rule.column) parts.push(`status in (${rule.column.statusIds.join(', ')})`); else parts.push('statusCategory != Done');
  if (rule.assignee) parts.push(`assignee = ${quote(rule.assignee.id)}`);
  if (rule.label) parts.push(`labels = ${quote(rule.label)}`);
  return `${parts.join(' AND ')} ORDER BY created ASC`;
}

function roots(access: JiraAccess): { api: string; agile: string } {
  if (access.kind === 'data-center') return { api: `${access.site}/rest/api/2`, agile: `${access.site}/rest/agile/1.0` };
  const base = access.gateway ? `https://api.atlassian.com/ex/jira/${access.gateway}` : access.site;
  return { api: `${base}/rest/api/3`, agile: `${base}/rest/agile/1.0` };
}
function authorization(access: JiraAccess): string {
  return access.kind === 'cloud' ? `Basic ${Buffer.from(`${access.email}:${access.token}`).toString('base64')}` : `Bearer ${access.token}`;
}
async function call(fetcher: Fetch, access: JiraAccess, url: string, body?: unknown): Promise<RemoteResponse> {
  return remote(fetcher, 'Jira', url, { headers: { authorization: authorization(access) }, ...(body === undefined ? {} : { method: 'POST', body }) });
}
function rejected(access: JiraAccess): AppError {
  return new AppError('token_rejected', access.kind === 'cloud'
    ? 'Jira did not accept this email and token. The token may be mistyped, expired or revoked, or it belongs to another account.'
    : 'Jira did not accept this personal access token. It may be mistyped, expired or revoked.', 422);
}
/** Throws for anything but 200, in words the person can act on. */
function ok(response: RemoteResponse, access: JiraAccess, what: string): unknown {
  if (response.status === 200) return response.json;
  if (response.status === 401) throw rejected(access);
  if (response.status === 403) throw new AppError('not_reachable', `This account may not ${what} in Jira. Check its permissions${access.gateway ? ' and the token scopes (read:jira-work)' : ''}.`, 422);
  if (response.status === 404) throw new AppError('not_reachable', `Jira could not find what is needed to ${what}. Check the project and the address.`, 422);
  const message = text(list(record(response.json).errorMessages)[0]);
  throw new AppError('jira_refused', `Jira could not ${what}${message ? `: ${message}` : ` (${response.status})`}.`, 422);
}

/**
 * Confirms the token and names the account. A Jira Cloud token created "with scopes" is refused on
 * the site address and only works through Atlassian's gateway, so that is tried second.
 */
export async function verifyJira(fetcher: Fetch, access: JiraAccess): Promise<{ account: string; gateway?: string }> {
  const name = (json: unknown) => text(record(json).displayName, 120) || text(record(json).emailAddress, 120) || text(record(json).name, 120);
  const { gateway: _, ...plain } = access;
  const direct = await call(fetcher, plain, `${roots(plain).api}/myself`);
  if (direct.status === 200 && name(direct.json)) return { account: name(direct.json) };
  if (access.kind === 'data-center') { ok(direct, access, 'read your profile'); throw rejected(access); }
  if (![401, 403, 404].includes(direct.status)) ok(direct, access, 'read your profile');
  const tenant = await remote(fetcher, 'Jira', `${access.site}/_edge/tenant_info`, { headers: {} });
  const cloudId = text(record(tenant.json).cloudId, 64);
  if (tenant.status !== 200 || !/^[A-Za-z0-9-]{8,64}$/.test(cloudId)) {
    if (direct.status === 404) throw new AppError('not_reachable', 'No Jira Cloud site answers at this address. Check it, for example example.atlassian.net.', 422);
    throw rejected(access);
  }
  const scoped = { ...access, gateway: cloudId };
  const viaGateway = await call(fetcher, scoped, `${roots(scoped).api}/myself`);
  if (viaGateway.status === 200 && name(viaGateway.json)) return { account: name(viaGateway.json), gateway: cloudId };
  throw rejected(access);
}

export async function jiraProjects(fetcher: Fetch, access: JiraAccess): Promise<{ key: string; name: string }[]> {
  const { api } = roots(access);
  const json = ok(await call(fetcher, access, access.kind === 'cloud' ? `${api}/project/search?maxResults=100&orderBy=name` : `${api}/project`), access, 'list projects');
  return list(access.kind === 'cloud' ? record(json).values : json)
    .map(p => ({ key: text(record(p).key, 50), name: text(record(p).name, 120) })).filter(p => p.key).slice(0, 200);
}

async function boardColumns(fetcher: Fetch, access: JiraAccess, key: string): Promise<JiraColumn[] | undefined> {
  const { agile } = roots(access);
  const boards = await call(fetcher, access, `${agile}/board?projectKeyOrId=${encodeURIComponent(key)}&maxResults=1`);
  const id = record(list(record(boards.json).values)[0]).id;
  if (boards.status !== 200 || (typeof id !== 'number' && typeof id !== 'string')) return;
  const configuration = await call(fetcher, access, `${agile}/board/${encodeURIComponent(String(id))}/configuration`);
  if (configuration.status !== 200) return;
  const columns = list(record(record(configuration.json).columnConfig).columns).map(c => ({
    name: text(record(c).name, 120), statusIds: list(record(c).statuses).map(s => text(record(s).id, 20)).filter(s => /^\d+$/.test(s)),
  })).filter(c => c.name && c.statusIds.length);
  return columns.length ? columns : undefined;
}
/** One project by key, as this account sees it. A large Jira has more projects than any list shows, so a rule's project is looked up directly. */
export async function jiraProject(fetcher: Fetch, access: JiraAccess, key: string): Promise<{ key: string; name: string } | undefined> {
  const response = await call(fetcher, access, `${roots(access).api}/project/${encodeURIComponent(key)}`);
  if (response.status === 404) return undefined;
  const found = record(ok(response, access, 'read the project'));
  const project = { key: text(found.key, 50), name: text(found.name, 120) };
  return project.key ? project : undefined;
}
const person = (access: JiraAccess, value: unknown): JiraUser => ({ id: text(access.kind === 'cloud' ? record(value).accountId : record(value).name, 200), name: text(record(value).displayName, 120) });
/** People who can be assigned tickets in a project, matching what was typed. Jira Cloud takes `query`, Data Center `username`. */
export async function jiraPeople(fetcher: Fetch, access: JiraAccess, key: string, query: string, limit = SUGGESTION_LIMIT): Promise<JiraUser[]> {
  const filter = query ? `&${access.kind === 'cloud' ? 'query' : 'username'}=${encodeURIComponent(query)}` : '';
  const response = await call(fetcher, access, `${roots(access).api}/user/assignable/search?project=${encodeURIComponent(key)}&maxResults=${limit}${filter}`);
  // A token without permission to browse users still gets the other filters; this one is then empty.
  if (response.status === 403) return [];
  return list(ok(response, access, 'list the people in this project')).map(u => person(access, u)).filter(u => u.id && u.name);
}
/** The one assignable person a rule names: by ID when it comes from the page, by exact display name when it comes from the terminal. */
export async function jiraAssignee(fetcher: Fetch, access: JiraAccess, key: string, reference: string): Promise<{ user?: JiraUser; sameName: number }> {
  if (access.kind === 'cloud') {
    const byId = await call(fetcher, access, `${roots(access).api}/user/assignable/search?project=${encodeURIComponent(key)}&maxResults=2&accountId=${encodeURIComponent(reference)}`);
    const user = byId.status === 200 ? list(byId.json).map(u => person(access, u)).find(u => u.id === reference) : undefined;
    if (user) return { user, sameName: 1 };
  }
  const found = await jiraPeople(fetcher, access, key, reference, 50);
  const exact = found.find(u => u.id === reference); if (exact) return { user: exact, sameName: 1 };
  const named = found.filter(u => u.name.localeCompare(reference, undefined, { sensitivity: 'accent' }) === 0);
  return named.length === 1 ? { user: named[0]!, sameName: 1 } : { sameName: named.length };
}
/** Type-ahead for the rule editor: projects, assignable people of a project, and labels. */
export async function jiraSuggest(fetcher: Fetch, access: JiraAccess, kind: 'projects' | 'people' | 'labels', query: string, projectKey?: string): Promise<JiraSuggestion[]> {
  const { api } = roots(access); const typed = query.trim().slice(0, 100); const wanted = typed.toLowerCase();
  if (kind === 'projects') {
    if (access.kind === 'cloud') {
      const json = ok(await call(fetcher, access, `${api}/project/search?maxResults=${SUGGESTION_LIMIT}&orderBy=name${typed ? `&query=${encodeURIComponent(typed)}` : ''}`), access, 'list projects');
      return list(record(json).values).map(p => ({ id: text(record(p).key, 50), name: text(record(p).name, 120) })).filter(p => p.id);
    }
    return (await jiraProjects(fetcher, access)).filter(p => !wanted || p.key.toLowerCase().includes(wanted) || p.name.toLowerCase().includes(wanted)).slice(0, SUGGESTION_LIMIT).map(p => ({ id: p.key, name: p.name }));
  }
  if (kind === 'people') {
    if (!projectKey) throw new AppError('invalid_request', 'Choose a Jira project first');
    return jiraPeople(fetcher, access, projectKey, typed);
  }
  // Jira's own JQL completion knows every label; the plain label list is the fallback where it is not offered.
  const completed = await call(fetcher, access, `${api}/jql/autocompletedata/suggestions?fieldName=labels&fieldValue=${encodeURIComponent(typed)}`).catch(() => undefined);
  let labels = completed?.status === 200 ? list(record(completed.json).results).map(r => text(record(r).value, 255).replace(/^"(.*)"$/, '$1')) : undefined;
  if (!labels) {
    const listed = await call(fetcher, access, `${api}/label?maxResults=200`).catch(() => undefined);
    labels = listed?.status === 200 ? list(record(listed.json).values).map(l => text(l, 255)).filter(l => !wanted || l.toLowerCase().includes(wanted)) : [];
  }
  return [...new Set(labels.filter(l => l && !/\s/.test(l)))].slice(0, SUGGESTION_LIMIT).map(l => ({ id: l, name: l }));
}
/** A project's columns: from its first board, or its statuses when it has none. */
export async function jiraColumns(fetcher: Fetch, access: JiraAccess, key: string): Promise<Pick<JiraOptions, 'columns' | 'columnsFrom'>> {
  const board = await boardColumns(fetcher, access, key).catch(error => { if (error instanceof AppError && error.code === 'integration_unavailable') throw error; return undefined; });
  if (board) return { columns: board, columnsFrom: 'board' };
  const seen = new Map<string, JiraColumn>();
  for (const type of list(ok(await call(fetcher, access, `${roots(access).api}/project/${encodeURIComponent(key)}/statuses`), access, 'read the project\'s statuses'))) {
    for (const status of list(record(type).statuses)) {
      const id = text(record(status).id, 20); const name = text(record(status).name, 120);
      if (/^\d+$/.test(id) && name && !seen.has(id)) seen.set(id, { name, statusIds: [id] });
    }
  }
  return { columns: [...seen.values()], columnsFrom: 'statuses' };
}
/** What the pick-up rule can choose from for one Jira project. Columns come from the project's first board; without one, each status is a column. */
export async function jiraOptions(fetcher: Fetch, access: JiraAccess, key: string): Promise<JiraOptions> {
  const { api } = roots(access); const project = encodeURIComponent(key);
  const [board, users, labels] = await Promise.all([
    boardColumns(fetcher, access, key).catch(error => { if (error instanceof AppError && error.code === 'integration_unavailable') throw error; return undefined; }),
    call(fetcher, access, `${api}/user/assignable/search?project=${project}&maxResults=100`),
    call(fetcher, access, `${api}/label?maxResults=200`).catch(() => undefined),
  ]);
  let columns = board;
  if (!columns) {
    const seen = new Map<string, JiraColumn>();
    for (const type of list(ok(await call(fetcher, access, `${api}/project/${project}/statuses`), access, 'read the project\'s statuses'))) {
      for (const status of list(record(type).statuses)) {
        const id = text(record(status).id, 20); const name = text(record(status).name, 120);
        if (/^\d+$/.test(id) && name && !seen.has(id)) seen.set(id, { name, statusIds: [id] });
      }
    }
    columns = [...seen.values()];
  }
  return {
    columns, columnsFrom: board ? 'board' : 'statuses',
    // A token without permission to browse users still gets columns and labels; the assignee filter is then empty.
    users: list(users.status === 403 ? [] : ok(users, access, 'list the people in this project')).map(u => ({
      id: text(access.kind === 'cloud' ? record(u).accountId : record(u).name, 200), name: text(record(u).displayName, 120),
    })).filter(u => u.id && u.name),
    labels: labels?.status === 200 ? list(record(labels.json).values).map(l => text(l, 255)).filter(l => l && !/\s/.test(l)) : [],
  };
}

/** How many tickets the rule matches now, and the first few keys. Jira Cloud only offers an approximate count. */
export async function jiraMatches(fetcher: Fetch, access: JiraAccess, jql: string): Promise<JiraMatches> {
  const { api } = roots(access);
  const keys = (json: unknown) => list(record(json).issues).map(i => text(record(i).key, 60)).filter(Boolean).slice(0, 5);
  if (access.kind === 'data-center') {
    const json = ok(await call(fetcher, access, `${api}/search`, { jql, maxResults: 5, fields: ['summary'] }), access, 'search tickets');
    const total = record(json).total;
    return { count: typeof total === 'number' ? total : null, keys: keys(json) };
  }
  const [found, counted] = await Promise.all([
    call(fetcher, access, `${api}/search/jql`, { jql, maxResults: 5, fields: ['summary'] }),
    call(fetcher, access, `${api}/search/approximate-count`, { jql }).catch(() => undefined),
  ]);
  const count = counted?.status === 200 ? record(counted.json).count : undefined;
  return { count: typeof count === 'number' ? count : null, keys: keys(ok(found, access, 'search tickets')) };
}
