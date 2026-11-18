import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { createApi } from '../../src/api/server.js';
import { ProjectIntegrationService } from '../../src/integrations/service.js';
import { EnvironmentSecretStore, type SecretStore } from '../../src/security/secret-store.js';
import { fixture } from '../helpers.js';
import { downloadTicketFiles } from '../../src/integrations/ticket-files.js';

const GITHUB_TOKEN = `github_pat_${'Fixture1'.repeat(6)}`;
const NEWER_GITHUB_TOKEN = `github_pat_${'Fixture2'.repeat(6)}`;
const JIRA_TOKEN = `ATATT3xFfGF0${'fixtureToken'.repeat(3)}`;
const SCOPED_TOKEN = `ATATT3xFfGF0${'scopedToken0'.repeat(3)}`;
const PAT = 'fixture-personal-access-token-0123456789';

function memorySecrets(): SecretStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return { mode: 'vault', values, variable: name => `VAR_${name}`, locked: async () => false, get: async name => values.get(name), set: async (name, value) => { values.set(name, value); }, remove: async name => { values.delete(name); } };
}
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
/** A deterministic GitHub and Jira. Every request is recorded so tests can assert what was sent where. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
function remotes(state: { githubRevoked?: boolean } = {}) {
  const calls: { url: string; authorization: string | undefined; body: unknown }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); const headers = init?.headers as Record<string, string>; const authorization = headers.authorization;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined; calls.push({ url, authorization, body });
    assert.equal(init?.redirect, 'manual', 'a token is never followed through a redirect');
    if (url.startsWith('https://api.github.test/')) {
      if (![`Bearer ${GITHUB_TOKEN}`, `Bearer ${NEWER_GITHUB_TOKEN}`].includes(authorization ?? '') || state.githubRevoked) return json({ message: 'Bad credentials' }, 401);
      if (url.endsWith('/user')) return json({ login: 'fixture-user' }, 200, { 'github-authentication-token-expiration': authorization === `Bearer ${GITHUB_TOKEN}` ? '2027-01-10 12:00:00 UTC' : '2028-01-10 12:00:00 UTC' });
      if (url.endsWith('/repos/example-org/website')) return json({ full_name: 'example-org/website', permissions: { push: true } });
      return json({ message: 'Not Found' }, 404);
    }
    // Jira Cloud's storage host: it takes the signed link alone and must never see the sign-in.
    if (url === 'https://media.fixture.invalid/file/10001?token=signed') { assert.equal(authorization, undefined, 'the sign-in stays with Jira'); return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }); }
    const cloud = `Basic ${Buffer.from(`agents@example.com:${JIRA_TOKEN}`).toString('base64')}`;
    const scoped = `Basic ${Buffer.from(`agents@example.com:${SCOPED_TOKEN}`).toString('base64')}`;
    let api: string | undefined;
    if (url === 'https://example.atlassian.net/_edge/tenant_info') return json({ cloudId: 'cloud-id-0001' });
    if (url.startsWith('https://example.atlassian.net/rest/')) { if (authorization !== cloud) return json({}, 401); api = url.slice('https://example.atlassian.net'.length); }
    else if (url.startsWith('https://api.atlassian.com/ex/jira/cloud-id-0001/rest/')) { if (authorization !== scoped) return json({}, 401); api = url.slice('https://api.atlassian.com/ex/jira/cloud-id-0001'.length); }
    else if (url.startsWith('https://jira.example.com/jira/rest/')) { if (authorization !== `Bearer ${PAT}`) return json({}, 401); api = url.slice('https://jira.example.com/jira'.length); }
    if (!api) throw new TypeError('fetch failed');
    const path = api.replace(/^\/rest\/api\/[23]/, '/api');
    if (path === '/api/myself') return json({ displayName: 'DevAgents Bot', accountId: 'acc-bot' });
    const asked = new URL(url).searchParams; const has = (value: string, typed: string | null) => !typed || value.toLowerCase().includes(typed.toLowerCase());
    const cloudProjects = [{ key: 'WEB', name: 'Website' }, { key: 'API', name: 'Backend API' }]; const hostedProjects = [{ key: 'OPS', name: 'Operations' }];
    if (path.startsWith('/api/project/search')) return json({ values: cloudProjects.filter(p => has(p.key, asked.get('query')) || has(p.name, asked.get('query'))) });
    if (path === '/api/project') return json(hostedProjects);
    const one = /^\/api\/project\/([A-Za-z]+)$/.exec(path);
    if (one) { const project = (api.startsWith('/rest/api/2') ? hostedProjects : cloudProjects).find(p => p.key === one[1]); return project ? json(project) : json({ errorMessages: ['No project could be found with key'] }, 404); }
    if (path.startsWith('/api/jql/autocompletedata/suggestions')) return api.startsWith('/rest/api/2') ? json({}, 404) : json({ results: ['devagents', 'bug', '"two words"'].filter(l => has(l, asked.get('fieldValue'))).map(value => ({ value, displayName: `<b>${value}</b>` })) });
    if (path.startsWith('/rest/agile/1.0/board?')) return json(path.includes('projectKeyOrId=WEB') ? { values: [{ id: 7 }] } : { values: [] });
    if (path === '/rest/agile/1.0/board/7/configuration') return json({ columnConfig: { columns: [{ name: 'Backlog', statuses: [] }, { name: 'Ready for agents', statuses: [{ id: '10001' }, { id: '10002' }] }, { name: 'Done', statuses: [{ id: '10009' }] }] } });
    if (/^\/api\/project\/[A-Z]+\/statuses$/.test(path)) return json([{ statuses: [{ id: '1', name: 'To Do' }, { id: '3', name: 'In Progress' }] }, { statuses: [{ id: '1', name: 'To Do' }] }]);
    if (path.startsWith('/api/user/assignable/search')) {
      if (api.startsWith('/rest/api/2')) return json([{ name: 'bot', displayName: 'DevAgents Bot' }].filter(u => has(u.name, asked.get('username')) || has(u.displayName, asked.get('username'))));
      const people = [{ accountId: 'acc-bot', displayName: 'DevAgents Bot' }, { accountId: 'acc-1', displayName: 'Sam Example' }, { accountId: 'acc-2', displayName: 'Sam Example' }];
      return json(people.filter(u => (!asked.get('accountId') || u.accountId === asked.get('accountId')) && has(u.displayName, asked.get('query'))));
    }
    if (path.startsWith('/api/label')) return api.startsWith('/rest/api/2') ? json({}, 404) : json({ values: ['devagents', 'bug'] });
    if (path === '/api/search/approximate-count') return json({ count: 3 });
    if (path === '/api/search/jql') return String((body as { jql: string }).jql).includes('"broken"') ? json({ errorMessages: ['The value \'broken\' does not exist for the field \'labels\'.'] }, 400) : json({ issues: [{ key: 'WEB-12', fields: { summary: 'Add a contact form' } }, { key: 'WEB-15', fields: { summary: 'Fix the footer links' } }, { key: 'WEB-21', fields: { summary: 'Rework the landing page' } }] });
    if (path === '/api/search') return json({ total: 1, issues: [{ key: 'OPS-4' }] });
    if (path === '/api/attachment/content/10001') return new Response(null, { status: 303, headers: { location: 'https://media.fixture.invalid/file/10001?token=signed' } });
    if (path === '/api/attachment/content/10002') return new Response('Three fields.\n', { status: 200, headers: { 'content-type': 'text/plain' } });
    if (path.startsWith('/api/issue/WEB-12?')) return json({ key: 'WEB-12', fields: {
      summary: 'Add a contact form',
      description: { type: 'doc', content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Visitors cannot reach us. Ask ' }, { type: 'mention', attrs: { text: '@Sam Example' } }, { type: 'text', text: ' for the copy.' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'name' }] }] }, { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'email' }, { type: 'hardBreak' }, { type: 'text', text: 'required' }] }] }] },
        { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'm-1' } }] },
      ] },
      comment: { comments: [{ author: { displayName: 'Sam Example' }, created: '2026-11-02T09:15:00.000+0000', body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Send it to the support inbox.' }] }] } }] },
      attachment: [{ filename: 'footer.png', mimeType: 'image/png', size: 68, content: 'https://example.atlassian.net/rest/api/3/attachment/content/10001' }, { filename: 'notes.txt', mimeType: 'text/plain', size: 14, content: 'https://example.atlassian.net/rest/api/3/attachment/content/10002' }, { filename: 'design.fig', mimeType: 'application/octet-stream', size: 900, content: 'https://example.atlassian.net/rest/api/3/attachment/content/10003' }],
    } });
    if (path.startsWith('/api/issue/OPS-4?')) return json({ key: 'OPS-4', fields: { summary: 'Rotate the logs', description: 'Plain text\r\nfrom a hosted Jira.', comment: { comments: [] }, attachment: [] } });
    if (path.startsWith('/api/issue/')) return json({ errorMessages: ['Issue does not exist or you do not have permission to see it.'] }, 404);
    return json({}, 404);
  }) as typeof fetch;
  return { fetcher, calls };
}
async function serve(options: { secrets?: SecretStore; state?: { githubRevoked?: boolean }; origin?: boolean } = {}) {
  const f = await fixture(); const secrets = options.secrets ?? memorySecrets(); const { fetcher, calls } = remotes(options.state);
  if (options.origin !== false) execFileSync('git', ['-C', f.project, 'remote', 'add', 'origin', 'git@github.com:example-org/website.git']);
  let now = new Date('2026-11-13T12:00:00Z');
  const integrations = new ProjectIntegrationService(f.store, secrets, { fetch: fetcher, githubApiUrl: 'https://api.github.test', now: () => now });
  const server = createApi(f.service, 'test-token', { integrations });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; const base = `${root}/projects/fixture/integrations`;
  const call = async (path: string, method = 'GET', body?: unknown, project = 'fixture') => {
    const response = await fetch(`${root}/projects/${project}/integrations${path}`, { method, headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, text, data: JSON.parse(text) as Record<string, any> };
  };
  /** A second registered checkout of the same repository, to share a token with. */
  const second = async () => {
    const path = `${f.root}/second`;
    execFileSync('git', ['clone', '-q', f.project, path]); execFileSync('git', ['-C', path, 'remote', 'set-url', 'origin', 'https://github.com/example-org/website.git']);
    await f.service.registerProject({ id: 'second', path });
  };
  return { f, secrets, calls, call, base, second, integrations, setNow: (value: string) => { now = new Date(value); }, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.cleanup(); } };
}

test('GitHub: a token is verified against the folder\'s repository, kept out of every response, rechecked and removed', async () => {
  const state: { githubRevoked?: boolean } = {}; const s = await serve({ state }); const secrets = s.secrets as ReturnType<typeof memorySecrets>;
  try {
    assert.equal((await fetch(s.base)).status, 401);
    const empty = await s.call('');
    assert.equal(empty.status, 200); assert.equal(empty.data.github, null); assert.equal(empty.data.jira, null);
    assert.deepEqual(empty.data.folder.repository, 'example-org/website');
    assert.equal((await s.call('/github', 'PUT', {})).data.error, 'token_required');
    assert.equal((await s.call('/github', 'PUT', { token: 'gh_not-a-github-token-shape' })).data.error, 'invalid_token');
    const rejected = await s.call('/github', 'PUT', { token: `ghp_${'wrong123'.repeat(5)}` });
    assert.equal(rejected.status, 422); assert.equal(rejected.data.error, 'token_rejected'); assert.equal(secrets.values.size, 0, 'a refused token is not saved');
    assert.equal((await s.call('/github', 'PUT', { token: GITHUB_TOKEN, repository: 'example-org/private' })).data.error, 'not_reachable');

    const connected = await s.call('/github', 'PUT', { token: GITHUB_TOKEN });
    assert.equal(connected.status, 200);
    assert.deepEqual({ ...connected.data.github, connectedAt: 0, checkedAt: 0 }, { savedToken: 'github-fixture-user', repository: 'example-org/website', tokenKind: 'fine-grained', login: 'fixture-user', canPush: true, expiresAt: '2027-01-10T12:00:00.000Z', state: 'connected', expiresInDays: 58, connectedAt: 0, checkedAt: 0 });
    assert.deepEqual([...secrets.values], [['github-fixture-user', GITHUB_TOKEN]], 'the token is stored under its account, not under the project');
    assert.deepEqual(connected.data.savedTokens.github, [{ id: 'github-fixture-user', label: '@fixture-user', usedBy: [{ id: 'fixture', name: 'fixture' }] }]);
    const everywhere = [connected.text, (await s.call('')).text, JSON.stringify(s.f.store.projects())].join('\n');
    assert.equal(everywhere.includes(GITHUB_TOKEN), false, 'the token appears in no response and not in the database');
    assert.equal(s.f.store.project('fixture').version, 0, 'connecting does not make a default-team edit stale');

    s.setNow('2027-01-03T12:00:00Z');
    assert.equal((await s.call('')).data.github.state, 'expiring');
    state.githubRevoked = true;
    const failed = await s.call('/github/check', 'POST', {});
    assert.equal(failed.status, 200); assert.equal(failed.data.github.state, 'rejected'); assert.equal(failed.data.github.problem.code, 'token_rejected');
    assert.equal(failed.data.github.repository, 'example-org/website', 'a failed check keeps the connection so the token can be replaced');
    state.githubRevoked = false;
    const recovered = await s.call('/github/check', 'POST', {});
    assert.equal(recovered.data.github.problem, undefined); assert.equal(recovered.data.github.state, 'expiring');

    const removed = await s.call('/github', 'DELETE');
    assert.equal(removed.data.github, null); assert.equal(secrets.values.size, 0);
    assert.equal(s.f.store.project('fixture').integrations, undefined);
    assert.equal((await s.call('/github/check', 'POST', {})).status, 404);
    assert.equal((await fetch(`${s.base.replace('/fixture/', '/unknown/')}`, { headers: { authorization: 'Bearer test-token' } })).status, 404);
    for (const call of s.calls.filter(c => c.url.startsWith('https://api.github.test/'))) assert.match(call.authorization ?? '', /^Bearer /);
  } finally { await s.close(); }
});

test('GitHub: a folder without a GitHub remote asks for the repository', async () => {
  const s = await serve({ origin: false });
  try {
    assert.equal((await s.call('')).data.folder.repository, null);
    assert.equal((await s.call('/github', 'PUT', { token: GITHUB_TOKEN })).data.error, 'repository_unknown');
    assert.equal((await s.call('/github', 'PUT', { token: GITHUB_TOKEN, repository: 'example-org/website' })).data.github.repository, 'example-org/website');
  } finally { await s.close(); }
});

test('Jira Cloud: email and API token connect, the rule is resolved against live choices and saved only when Jira accepts it', async () => {
  const s = await serve(); const secrets = s.secrets as ReturnType<typeof memorySecrets>;
  try {
    assert.equal((await s.call('/jira', 'PUT', { kind: 'cloud', site: 'example.atlassian.net', token: JIRA_TOKEN })).status, 400);
    assert.equal((await s.call('/jira', 'PUT', { kind: 'cloud', site: 'http://example.atlassian.net', email: 'agents@example.com', token: JIRA_TOKEN })).data.error, 'invalid_site');
    assert.equal((await s.call('/jira', 'PUT', { kind: 'cloud', site: 'example.atlassian.net', email: 'other@example.com', token: JIRA_TOKEN })).data.error, 'token_rejected');
    assert.equal((await s.call('/jira/options')).status, 404, 'choices need a connection');
    const connected = await s.call('/jira', 'PUT', { kind: 'cloud', site: 'example.atlassian.net', email: 'agents@example.com', token: JIRA_TOKEN, expiresOn: '2027-11-12' });
    assert.equal(connected.status, 200);
    const jiraToken = connected.data.jira.savedToken as string; assert.match(jiraToken, /^jira-[a-f0-9]{20}$/);
    assert.deepEqual({ ...connected.data.jira, connectedAt: 0, checkedAt: 0 }, { savedToken: jiraToken, kind: 'cloud', site: 'https://example.atlassian.net', email: 'agents@example.com', account: 'DevAgents Bot', expiresOn: '2027-11-12', state: 'connected', expiresInDays: 364, connectedAt: 0, checkedAt: 0 });
    assert.equal(secrets.values.get(jiraToken), JIRA_TOKEN);

    assert.deepEqual((await s.call('/jira/options')).data, { projects: [{ key: 'WEB', name: 'Website' }, { key: 'API', name: 'Backend API' }] });
    const choices = (await s.call('/jira/options?project=WEB')).data.options;
    assert.deepEqual(choices.columns, [{ name: 'Ready for agents', statusIds: ['10001', '10002'] }, { name: 'Done', statusIds: ['10009'] }]);
    assert.equal(choices.columnsFrom, 'board'); assert.deepEqual(choices.labels, ['devagents', 'bug']); assert.equal(choices.users.length, 3);
    const noBoard = (await s.call('/jira/options?project=API')).data.options;
    assert.deepEqual(noBoard.columns, [{ name: 'To Do', statusIds: ['1'] }, { name: 'In Progress', statusIds: ['3'] }]); assert.equal(noBoard.columnsFrom, 'statuses');

    // Type-ahead: each kind is looked up in Jira with what was typed.
    assert.deepEqual((await s.call('/jira/suggest?kind=projects&query=web')).data, { items: [{ id: 'WEB', name: 'Website' }] });
    assert.equal((await s.call('/jira/suggest?kind=projects&query=')).data.items.length, 2);
    assert.equal((await s.call('/jira/suggest?kind=people&query=sam')).status, 400, 'people belong to a project');
    assert.deepEqual((await s.call('/jira/suggest?kind=people&query=sam&project=WEB')).data.items, [{ id: 'acc-1', name: 'Sam Example' }, { id: 'acc-2', name: 'Sam Example' }]);
    assert.deepEqual((await s.call('/jira/suggest?kind=people&query=nobody&project=WEB')).data.items, []);
    assert.deepEqual((await s.call('/jira/suggest?kind=labels&query=dev')).data.items, [{ id: 'devagents', name: 'devagents' }]);
    assert.deepEqual((await s.call('/jira/suggest?kind=labels&query=')).data.items.map((l: { id: string }) => l.id), ['devagents', 'bug'], 'a label with a space cannot be used in a rule and is left out');
    assert.equal((await s.call('/jira/suggest?kind=columns')).status, 400);
    assert.deepEqual((await s.call('/jira/columns?project=WEB')).data, { options: { columns: [{ name: 'Ready for agents', statusIds: ['10001', '10002'] }, { name: 'Done', statusIds: ['10009'] }], columnsFrom: 'board' } });
    // A person chosen from the list is saved by ID, also when two people share the name.
    assert.deepEqual((await s.call('/jira/preview', 'POST', { project: 'WEB', assignee: 'acc-2' })).data.rule.assignee, { id: 'acc-2', name: 'Sam Example' });

    assert.equal((await s.call('/jira/rule', 'PUT', {})).status, 400, 'a rule names a project');
    const open = await s.call('/jira/preview', 'POST', { project: 'WEB' });
    assert.equal(open.status, 200, open.text); assert.equal(open.data.rule.jql, 'project = "WEB" AND statusCategory != Done ORDER BY created ASC', 'without filters a rule means the project\'s open tickets');
    const unknown = await s.call('/jira/preview', 'POST', { project: 'WEB', column: 'Nowhere' });
    assert.equal(unknown.data.error, 'invalid_rule'); assert.match(unknown.data.message, /Ready for agents, Done/);
    assert.match((await s.call('/jira/preview', 'POST', { project: 'WEB', assignee: 'Sam Example' })).data.message, /Several people/);
    assert.equal((await s.call('/jira/preview', 'POST', { project: 'NOPE', label: 'devagents' })).data.error, 'invalid_rule');
    const refused = await s.call('/jira/rule', 'PUT', { project: 'WEB', label: 'broken' });
    assert.equal(refused.data.error, 'jira_refused'); assert.equal(s.f.store.project('fixture').integrations?.jira?.rule, undefined, 'a rule Jira refuses is not saved');

    const preview = await s.call('/jira/preview', 'POST', { project: 'web', column: 'ready for agents', assignee: 'devagents bot' });
    assert.deepEqual(preview.data.matches, { count: 3, keys: ['WEB-12', 'WEB-15', 'WEB-21'] });
    assert.equal(preview.data.rule.jql, 'project = "WEB" AND status in (10001, 10002) AND assignee = "acc-bot" ORDER BY created ASC');
    assert.equal(s.f.store.project('fixture').integrations?.jira?.rule, undefined, 'a preview saves nothing');
    const saved = await s.call('/jira/rule', 'PUT', { project: 'WEB', column: 'Ready for agents', label: 'devagents', start: 'auto' });
    assert.equal(saved.status, 200);
    assert.deepEqual({ ...saved.data.integrations.jira.rule, savedAt: 0 }, { project: { key: 'WEB', name: 'Website' }, column: { name: 'Ready for agents', statusIds: ['10001', '10002'] }, label: 'devagents', start: 'auto', jql: 'project = "WEB" AND status in (10001, 10002) AND labels = "devagents" ORDER BY created ASC', savedAt: 0 });

    // The rule can be removed and saved again; the connection and its token stay.
    const removed = await s.call('/jira/rule', 'DELETE');
    assert.equal(removed.status, 200); assert.equal(removed.data.jira.rule, undefined); assert.equal(removed.data.jira.state, 'connected');
    assert.equal((await s.call('/jira/rule', 'PUT', { project: 'WEB', column: 'Ready for agents', label: 'devagents', start: 'auto' })).status, 200);

    // Replacing the token for the same site keeps the rule; another site drops it.
    const replaced = await s.call('/jira', 'PUT', { kind: 'cloud', site: 'https://example.atlassian.net/', email: 'agents@example.com', token: JIRA_TOKEN });
    assert.equal(replaced.data.jira.rule.label, 'devagents'); assert.equal(replaced.data.jira.expiresOn, undefined, 'a new token has a new, unknown end date');
    const moved = await s.call('/jira', 'PUT', { kind: 'data-center', site: 'https://jira.example.com/jira', token: PAT });
    assert.equal(moved.data.jira.kind, 'data-center'); assert.equal(moved.data.jira.rule, undefined); assert.equal(moved.data.jira.email, undefined);
    assert.deepEqual([...secrets.values], [[moved.data.jira.savedToken, PAT]], 'the token of the Jira this project left is forgotten');
    assert.deepEqual((await s.call('/jira/preview', 'POST', { project: 'OPS', assignee: 'DevAgents Bot' })).data.matches, { count: 1, keys: ['OPS-4'] });
    assert.equal((await s.call('/jira', 'DELETE')).data.jira, null); assert.equal(secrets.values.size, 0);

    const text = JSON.stringify(s.f.store.projects());
    for (const secret of [JIRA_TOKEN, PAT]) assert.equal(text.includes(secret), false);
    for (const call of s.calls) {
      if (call.url.startsWith('https://example.atlassian.net/rest/')) assert.match(call.authorization ?? '', /^Basic /);
      if (call.url.startsWith('https://jira.example.com/')) { assert.equal(call.authorization, `Bearer ${PAT}`); assert.match(call.url, /\/jira\/rest\/(api\/2|agile\/1\.0)\//); }
      if (call.url.endsWith('/_edge/tenant_info')) assert.equal(call.authorization, undefined, 'the tenant lookup carries no credentials');
    }
  } finally { await s.close(); }
});

test('Jira Cloud: a token created with scopes is used through the Atlassian gateway', async () => {
  const s = await serve();
  try {
    const connected = await s.call('/jira', 'PUT', { kind: 'cloud', site: 'example.atlassian.net', email: 'agents@example.com', token: SCOPED_TOKEN });
    assert.equal(connected.status, 200); assert.equal(connected.data.jira.gateway, 'cloud-id-0001');
    const before = s.calls.length;
    assert.equal((await s.call('/jira/options?project=WEB')).status, 200);
    for (const call of s.calls.slice(before)) assert.match(call.url, /^https:\/\/api\.atlassian\.com\/ex\/jira\/cloud-id-0001\//);
    assert.equal((await s.call('/jira/check', 'POST', {})).data.jira.gateway, 'cloud-id-0001');
  } finally { await s.close(); }
});

test('one saved token serves every project on its account: reused without pasting, replaced once, forgotten with its last project', async () => {
  const state: { githubRevoked?: boolean } = {}; const s = await serve({ state }); const secrets = s.secrets as ReturnType<typeof memorySecrets>;
  try {
    await s.second();
    assert.equal((await s.call('/github', 'PUT', { token: GITHUB_TOKEN })).status, 200);
    const offered = await s.call('', 'GET', undefined, 'second');
    assert.equal(offered.data.github, null);
    assert.deepEqual(offered.data.savedTokens.github, [{ id: 'github-fixture-user', label: '@fixture-user', usedBy: [{ id: 'fixture', name: 'fixture' }] }]);
    assert.equal((await s.call('/github', 'PUT', { savedToken: 'github-someone-else' }, 'second')).data.error, 'unknown_saved_token');
    assert.equal((await s.call('/github', 'PUT', { savedToken: 'github-fixture-user', token: GITHUB_TOKEN }, 'second')).status, 400);
    const reused = await s.call('/github', 'PUT', { savedToken: 'github-fixture-user' }, 'second');
    assert.equal(reused.status, 200); assert.equal(reused.data.github.savedToken, 'github-fixture-user'); assert.equal(reused.data.github.state, 'connected');
    assert.deepEqual(reused.data.savedTokens.github[0].usedBy, [{ id: 'fixture', name: 'fixture' }, { id: 'second', name: 'second' }]);
    assert.equal(secrets.values.size, 1, 'both projects use the one stored token');

    // A refusal found by one project is shown on the other, and so is the recovery.
    state.githubRevoked = true;
    assert.equal((await s.call('/github/check', 'POST', {}, 'second')).data.github.state, 'rejected');
    assert.equal((await s.call('')).data.github.state, 'rejected');
    state.githubRevoked = false;
    assert.equal((await s.call('/github/check', 'POST', {})).data.github.state, 'connected');
    assert.equal((await s.call('', 'GET', undefined, 'second')).data.github.problem, undefined);

    // Replacing it on one project replaces it for both.
    const replaced = await s.call('/github', 'PUT', { token: NEWER_GITHUB_TOKEN });
    assert.equal(replaced.data.github.expiresAt, '2028-01-10T12:00:00.000Z');
    assert.deepEqual([...secrets.values], [['github-fixture-user', NEWER_GITHUB_TOKEN]]);
    assert.equal((await s.call('', 'GET', undefined, 'second')).data.github.expiresAt, '2028-01-10T12:00:00.000Z');

    // Jira: the saved token brings its site and account; the rule stays per project.
    const jira = await s.call('/jira', 'PUT', { kind: 'cloud', site: 'example.atlassian.net', email: 'agents@example.com', token: JIRA_TOKEN, expiresOn: '2027-11-12' });
    await s.call('/jira/rule', 'PUT', { project: 'WEB', label: 'devagents' });
    const id = jira.data.jira.savedToken as string;
    assert.equal((await s.call('/jira', 'PUT', { savedToken: id, site: 'example.atlassian.net' }, 'second')).status, 400);
    const shared = await s.call('/jira', 'PUT', { savedToken: id }, 'second');
    assert.deepEqual({ ...shared.data.jira, connectedAt: 0, checkedAt: 0 }, { savedToken: id, kind: 'cloud', site: 'https://example.atlassian.net', email: 'agents@example.com', account: 'DevAgents Bot', expiresOn: '2027-11-12', state: 'connected', expiresInDays: 364, connectedAt: 0, checkedAt: 0 });
    assert.deepEqual(shared.data.savedTokens.jira, [{ id, label: 'DevAgents Bot · example.atlassian.net', usedBy: [{ id: 'fixture', name: 'fixture' }, { id: 'second', name: 'second' }] }]);
    assert.equal(secrets.values.size, 2);

    // The token outlives the first project that disconnects and goes with the last one.
    await s.call('/github', 'DELETE'); await s.call('/jira', 'DELETE');
    assert.equal(secrets.values.size, 2); assert.equal((await s.call('/jira/options', 'GET', undefined, 'second')).status, 200);
    await s.call('/github', 'DELETE', undefined, 'second'); await s.call('/jira', 'DELETE', undefined, 'second');
    assert.equal(secrets.values.size, 0);
  } finally { await s.close(); }
});

test('without a vault a pasted token is refused and the environment token is used instead', async () => {
  const s = await serve({ secrets: new EnvironmentSecretStore({ DEVAGENTS_GITHUB_TOKEN_FIXTURE: GITHUB_TOKEN }) });
  try {
    const view = await s.call('');
    assert.deepEqual(view.data.secrets, { mode: 'environment', locked: false, githubVariable: 'DEVAGENTS_GITHUB_TOKEN_FIXTURE', jiraVariable: 'DEVAGENTS_JIRA_TOKEN_FIXTURE' });
    assert.deepEqual(view.data.savedTokens, { github: [], jira: [] }, 'environment tokens are one variable per project and are not shared');
    const pasted = await s.call('/github', 'PUT', { token: GITHUB_TOKEN });
    assert.equal(pasted.status, 409); assert.equal(pasted.data.error, 'vault_unconfigured');
    assert.equal((await s.call('/github', 'PUT', {})).data.github.login, 'fixture-user');
    const jira = await s.call('/jira', 'PUT', { kind: 'cloud', site: 'example.atlassian.net', email: 'agents@example.com' });
    assert.equal(jira.data.error, 'token_required'); assert.match(jira.data.message, /DEVAGENTS_JIRA_TOKEN_FIXTURE/);
  } finally { await s.close(); }
});

test('a service without integrations answers 503 instead of pretending', async () => {
  const f = await fixture(); const server = createApi(f.service, 'test-token');
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/projects/fixture/integrations`, { headers: { authorization: 'Bearer test-token' } });
    assert.equal(response.status, 503);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.cleanup(); }
});

test('Jira: one ticket is read with its text, comments and file names, and a task started from it records the ticket', async () => {
  const s = await serve();
  try {
    const content = async (key: string) => {
      const response = await fetch(`${s.base.replace('/projects/fixture/integrations', '')}/tickets/content?${new URLSearchParams({ projectId: 'fixture', source: 'jira', key })}`, { headers: { authorization: 'Bearer test-token' } });
      return { status: response.status, data: await response.json() as Record<string, any> };
    };
    assert.equal((await content('WEB-12')).data.error, 'not_connected');
    await s.call('/jira', 'PUT', { kind: 'cloud', site: 'example.atlassian.net', email: 'agents@example.com', token: JIRA_TOKEN });
    const read = await content('web-12');
    assert.equal(read.status, 200, JSON.stringify(read.data));
    assert.equal(read.data.request, [
      'WEB-12: Add a contact form', 'Visitors cannot reach us. Ask @Sam Example for the copy.\n- name\n- email\nrequired\n[file]',
      'Comments on the ticket:', 'Sam Example, 2026-11-02:\nSend it to the support inbox.', 'Files on the ticket: footer.png, notes.txt, design.fig', 'Ticket: https://example.atlassian.net/browse/WEB-12',
    ].join('\n\n'));
    assert.deepEqual(read.data.ticket.files, [{ name: 'footer.png', type: 'image/png', size: 68, kind: 'image' }, { name: 'notes.txt', type: 'text/plain', size: 14, kind: 'text' }, { name: 'design.fig', type: 'application/octet-stream', size: 900 }]);
    assert.equal(read.data.ticket.name, 'Jira'); assert.equal(read.data.ticket.source, 'jira');
    const missing = await content('WEB-99'); assert.equal(missing.status, 404); assert.equal(missing.data.error, 'ticket_unreadable');
    assert.equal((await content('not a key')).status, 400);
    const task = s.f.service.submit({ projectId: 'fixture', request: read.data.request, ticket: { source: 'jira', key: 'web-12', url: 'https://elsewhere.example.com/x' } }, 'from-jira');
    assert.deepEqual(task.ticket, { source: 'jira', name: 'Jira', key: 'WEB-12', url: 'https://example.atlassian.net/browse/WEB-12' }, 'the link is the connected Jira, whatever was sent');
  } finally { await s.close(); }
});

test('Jira: matching tickets are available, a started one leaves, and its files are fetched for the task and shown as pictures', async () => {
  const s = await serve(); const root = s.base.replace('/projects/fixture/integrations', '');
  const get = async (path: string) => { const response = await fetch(`${root}${path}`, { headers: { authorization: 'Bearer test-token' } }); return { status: response.status, type: response.headers.get('content-type'), bytes: Buffer.from(await response.arrayBuffer()) }; };
  try {
    await s.call('/jira', 'PUT', { kind: 'cloud', site: 'example.atlassian.net', email: 'agents@example.com', token: JIRA_TOKEN });
    assert.equal((await s.call('/jira/rule', 'PUT', { project: 'WEB', label: 'devagents' })).status, 200);
    const available = JSON.parse((await get('/tickets/available')).bytes.toString()) as { problems: unknown[]; tickets: { source: { kind: string; name: string; id: string }; key: string; title: string; url: string; why: string; projectId: string }[] };
    assert.deepEqual(available.problems, []);
    assert.deepEqual(available.tickets.map(t => `${t.source.id}/${t.key}/${t.title}`), ['jira/WEB-12/Add a contact form', 'jira/WEB-15/Fix the footer links', 'jira/WEB-21/Rework the landing page']);
    assert.deepEqual({ ...available.tickets[0]!.source, url: available.tickets[0]!.url, why: available.tickets[0]!.why }, { kind: 'jira', name: 'Jira', id: 'jira', url: 'https://example.atlassian.net/browse/WEB-12', why: 'label devagents' });

    // The preview in the submit form: through Jira's redirect, with the sign-in sent to Jira only.
    const picture = (index: number) => get(`/tickets/picture?${new URLSearchParams({ projectId: 'fixture', source: 'jira', key: 'WEB-12', index: String(index) })}`);
    const shown = await picture(0);
    assert.deepEqual([shown.status, shown.type, shown.bytes.equals(PNG)], [200, 'image/png', true]);
    assert.equal((await picture(1)).status, 404); assert.equal((await picture(2)).status, 404);

    // A task started from the ticket takes the picture and the text file; the other file stays on the ticket.
    const files: { saved: { name: string; file: string; kind: string; bytes: number }[]; skipped: { name: string; reason: string }[] }[] = [];
    s.f.service.attachTicketFiles(async (task, directory) => { const result = await downloadTicketFiles({ integrations: s.integrations }, task.projectId, task.ticket!, directory); files.push(result); return result; });
    const task = s.f.service.submit({ projectId: 'fixture', request: 'WEB-12: Add a contact form', mode: 'autonomous', ticket: { source: 'jira', key: 'WEB-12' } }, 'jira-files');
    await s.f.service.loadTicketFiles(task.id);
    assert.deepEqual(files[0], {
      saved: [{ name: 'footer.png', file: '01.png', kind: 'image', type: 'image/png', bytes: PNG.byteLength }, { name: 'notes.txt', file: '02.txt', kind: 'text', type: 'text/plain', bytes: 14 }],
      skipped: [{ name: 'design.fig', reason: 'only pictures and short text files are passed to the team' }],
    });
    const kept = await get(`/tasks/${task.id}/ticket-files/01.png`); assert.deepEqual([kept.status, kept.bytes.equals(PNG)], [200, true]);
    assert.match((await s.f.service.ticketMaterial(task.id)).text, /--- notes\.txt ---\nThree fields\.\n--- end of notes\.txt ---/);
    assert.deepEqual((JSON.parse((await get('/tickets/available')).bytes.toString()) as typeof available).tickets.map(t => t.key), ['WEB-15', 'WEB-21'], 'the started ticket is no longer available');
    assert.ok(s.calls.filter(c => c.url.includes('media.fixture.invalid')).every(c => c.authorization === undefined));
  } finally { await s.close(); }
});
