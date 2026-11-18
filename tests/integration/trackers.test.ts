import test from 'node:test';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assignStartedTicket } from '../../src/integrations/tickets.js';
import { suggestAssign } from '../../src/integrations/tracker-mapping.js';
import { McpSession } from '../../src/integrations/mcp.js';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { createApi } from '../../src/api/server.js';
import { TrackerService } from '../../src/integrations/trackers.js';
import { EnvironmentSecretStore, type SecretStore } from '../../src/security/secret-store.js';
import { fixture } from '../helpers.js';

type Call = { url: string; authorization?: string; method?: string; params?: { name?: string; arguments?: Record<string, unknown> }; redirect?: string };
type Fake = { fetcher: typeof fetch; calls: Call[] };
const fake = await import('../../scripts/fake-tracker.mjs' as string) as { FAKE_TRACKER_URL: string; FAKE_TRACKER_TOKEN: string; fakeTracker(state?: { revoked?: boolean; events?: boolean; limited?: boolean; updates?: Record<string, unknown>[] }): Fake };
const { FAKE_TRACKER_URL: URL_, FAKE_TRACKER_TOKEN: TOKEN } = fake;

function memorySecrets(): SecretStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return { mode: 'vault', values, variable: name => `VAR_${name}`, locked: async () => false, get: async name => values.get(name), set: async (name, value) => { values.set(name, value); }, remove: async name => { values.delete(name); } };
}
const MAPPING = {
  list: { tool: 'tracker_list_work', fixed: { assignment: 'all' }, filters: { project: { name: 'projectId', many: false }, column: { name: 'statuses', many: true }, label: { name: 'labels', many: true } } },
  result: { tickets: 'tasks', projects: 'projects', labels: 'labels', people: 'users', account: 'viewer' },
  ticket: { key: 'key', title: 'title', column: 'status', project: 'projectId', assignee: 'assignee', labels: 'labels', url: 'url' },
  columns: ['backlog', 'todo', 'ready-for-development', 'in-progress', 'done'],
  read: { tool: 'tracker_get_task', key: 'taskId' },
};
async function serve(options: { secrets?: SecretStore; state?: { revoked?: boolean; events?: boolean; limited?: boolean; updates?: Record<string, unknown>[] } } = {}) {
  const f = await fixture(); const secrets = options.secrets ?? memorySecrets(); const state = options.state ?? {}; const { fetcher, calls } = fake.fakeTracker(state);
  const trackers = new TrackerService(f.store, secrets, { fetch: fetcher, now: () => new Date('2026-11-17T12:00:00Z') });
  const server = createApi(f.service, 'test-token', { trackers });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`${root}${path}`, { method, headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, text, data: JSON.parse(text) as Record<string, any> };
  };
  /** Adds the fixture tool and saves the mapping DevAgents proposed. */
  const added = async (name = 'Fixture Tracker') => {
    const inspection = await call('/trackers', 'POST', { name, url: URL_, token: TOKEN });
    assert.equal(inspection.status, 201, inspection.text);
    const id = inspection.data.tracker.id as string;
    assert.equal((await call(`/trackers/${id}/mapping`, 'PUT', inspection.data.suggestion)).status, 200);
    return id;
  };
  return { f, root, secrets, state, calls, call, added, trackers, project: '/projects/fixture/integrations/trackers', close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.cleanup(); } };
}

test('a tool is added by its MCP address: the token is verified, kept out of every response and sent only to that address', async () => {
  const s = await serve(); const secrets = s.secrets as ReturnType<typeof memorySecrets>;
  try {
    assert.equal((await fetch(`${s.root}/trackers`)).status, 401);
    assert.deepEqual((await s.call('/trackers')).data, { secrets: { mode: 'vault', locked: false }, trackers: [] });
    assert.equal((await s.call('/trackers', 'POST', { name: 'Fixture Tracker', url: 'http://tracker.fixture.invalid/mcp', token: TOKEN })).data.error, 'invalid_site');
    assert.equal((await s.call('/trackers', 'POST', { name: 'Fixture Tracker', url: URL_ })).data.error, 'token_required');
    const rejected = await s.call('/trackers', 'POST', { name: 'Fixture Tracker', url: URL_, token: 'a-rejected-token-0001' });
    assert.equal(rejected.status, 422); assert.equal(rejected.data.error, 'token_rejected');
    assert.equal(secrets.values.size, 0, 'a refused token is not saved'); assert.equal((await s.call('/trackers')).data.trackers.length, 0);

    const added = await s.call('/trackers', 'POST', { name: 'Fixture Tracker', url: `${URL_}/`, token: TOKEN });
    assert.equal(added.status, 201, added.text);
    const tracker = added.data.tracker;
    assert.equal(tracker.url, URL_); assert.deepEqual(tracker.server, { name: 'Fixture Tracker', version: '1.2.0' });
    assert.equal(tracker.state, 'connected'); assert.equal(tracker.mapped, false); assert.deepEqual(tracker.usedBy, []);
    assert.deepEqual(added.data.tools.map((t: { name: string }) => t.name), ['tracker_list_work', 'tracker_get_task', 'tracker_update_task']);
    assert.deepEqual(added.data.suggestion, MAPPING, 'the mapping is proposed from the tool list and one answer');
    // One real ticket comes along, so the proposed fields can be checked against real values.
    assert.deepEqual({ key: added.data.sample.values.key, status: added.data.sample.values.status, labels: added.data.sample.values.labels, project: added.data.sample.names[added.data.sample.values.projectId] }, { key: 'FX-1', status: 'ready-for-development', labels: 'devagents', project: 'Website' });
    assert.deepEqual([...secrets.values], [['tracker-fixture-tracker', TOKEN]]);
    assert.ok(!added.text.includes(TOKEN) && !added.text.includes('savedToken'));
    assert.ok(s.calls.every(c => c.url === URL_ && c.redirect === 'manual'));
    assert.equal((await s.call('/trackers', 'POST', { name: 'fixture tracker', url: URL_, token: TOKEN })).data.error, 'tracker_conflict');

    // The suggestion is not saved until it is confirmed, and a wrong mapping is refused with what the server has.
    assert.equal((await s.call(`${s.project}/${tracker.id}`, 'PUT', {})).data.error, 'tracker_unmapped');
    const wrongTool = await s.call(`/trackers/${tracker.id}/mapping`, 'PUT', { ...MAPPING, list: { ...MAPPING.list, tool: 'tracker_missing' } });
    assert.equal(wrongTool.data.error, 'invalid_mapping');
    const wrongArgument = await s.call(`/trackers/${tracker.id}/mapping`, 'PUT', { ...MAPPING, list: { ...MAPPING.list, filters: { project: { name: 'board', many: false } } } });
    assert.match(wrongArgument.data.message, /takes no argument named board.*assignment, projectId, statuses, labels/);
    const wrongPath = await s.call(`/trackers/${tracker.id}/mapping`, 'PUT', { ...MAPPING, result: { tickets: 'issues' } });
    assert.match(wrongPath.data.message, /no list at "issues".*projects, tasks, users, labels/);
    const wrongField = await s.call(`/trackers/${tracker.id}/mapping`, 'PUT', { ...MAPPING, ticket: { key: 'number', title: 'title' } });
    assert.match(wrongField.data.message, /No entry of "tasks" has both "number" and "title"/);
    const mapped = await s.call(`/trackers/${tracker.id}/mapping`, 'PUT', MAPPING);
    assert.equal(mapped.status, 200, mapped.text); assert.equal(mapped.data.tickets, 5);
    assert.equal(mapped.data.tracker.mapped, true); assert.equal(mapped.data.tracker.account, 'agents@example.com');
    assert.deepEqual((await s.call(`/trackers/${tracker.id}`)).data.mapping, MAPPING);
  } finally { await s.close(); }
});

test('a project uses an added tool: options, a rule the tool or DevAgents filters, and a preview', async () => {
  const s = await serve();
  try {
    const id = await s.added();
    assert.deepEqual((await s.call(s.project)).data.connections, []);
    const one = `${s.project}/${id}`;
    const connected = await s.call(one, 'PUT', {});
    assert.equal(connected.status, 200, connected.text);
    assert.equal(connected.data.connections[0].tracker.name, 'Fixture Tracker'); assert.equal(connected.data.connections[0].connectedAt, '2026-11-17T12:00:00.000Z');
    assert.equal((await s.call(one, 'PUT', {})).data.connections.length, 1, 'connecting the same tool twice changes nothing');
    assert.deepEqual((await s.call(`/trackers/${id}`)).data.usedBy, [{ id: 'fixture', name: 'fixture' }]);

    const options = (await s.call(`${one}/options`)).data;
    assert.deepEqual(options.projects, [{ id: 'p-web', name: 'Website' }, { id: 'p-api', name: 'Backend API' }]);
    assert.deepEqual(options.columns, MAPPING.columns);
    assert.deepEqual(options.people, [{ id: 'u-sam', name: 'Sam Example' }, { id: 'u-bot', name: 'DevAgents Bot' }]);
    assert.deepEqual(options.labels, ['bug', 'devagents', 'feedback'], 'labels that are only on tickets are offered too');
    assert.deepEqual(options.filters, ['project', 'column', 'assignee', 'label']);

    // Every part is optional. With none, the rule means every ticket the account can see.
    const everything = await s.call(`${one}/preview`, 'POST', {});
    assert.equal(everything.status, 200, everything.text); assert.equal(everything.data.matches.total, 5);
    assert.deepEqual(s.calls.at(-1)!.params!.arguments, { assignment: 'all' });
    assert.equal((await s.call(`${one}/preview`, 'POST', { project: 'Website' })).status, 400, 'the old single-value names are refused');
    assert.match((await s.call(`${one}/preview`, 'POST', { columns: ['Ready'] })).data.message, /no column "Ready". Available: backlog, todo/);
    assert.match((await s.call(`${one}/preview`, 'POST', { projects: ['Shop'], labels: ['devagents'] })).data.message, /no project "Shop". Available: Website, Backend API/);

    // One value per part: the tool filters by itself wherever it has an argument.
    const preview = await s.call(`${one}/preview`, 'POST', { projects: ['website'], columns: ['Ready-For-Development'], labels: ['devagents'] });
    assert.equal(preview.status, 200, preview.text);
    assert.deepEqual(preview.data.matches, { total: 2, sample: [{ key: 'FX-1', title: 'Add a contact form', url: 'https://tracker.fixture.invalid/board?task=FX-1' }, { key: 'FX-2', title: 'Fix the footer links', url: 'https://tracker.fixture.invalid/board?task=FX-2' }] });
    assert.deepEqual(s.calls.at(-1)!.params!.arguments, { assignment: 'all', projectId: 'p-web', statuses: ['ready-for-development'], labels: ['devagents'] }, 'mapped filters are sent to the tool');
    assert.equal((await s.call(s.project)).data.connections[0].rule, undefined, 'a preview saves nothing');

    // Several values per part: any value of a part matches, and every filled part must match.
    const several = await s.call(`${one}/preview`, 'POST', { projects: ['Website', 'Backend API'], columns: ['todo', 'in-progress'], labels: ['feedback', 'bug'] });
    assert.deepEqual(several.data.matches.sample.map((t: { key: string }) => t.key), ['FX-5'], 'todo or in-progress, and feedback or bug');
    // Several columns go to the tool as its list; several projects and labels do not, because a tool may read a list there as "all of these".
    assert.deepEqual(s.calls.at(-1)!.params!.arguments, { assignment: 'all', statuses: ['todo', 'in-progress'] });
    const eitherLabel = await s.call(`${one}/preview`, 'POST', { labels: ['bug', 'feedback'] });
    assert.deepEqual(eitherLabel.data.matches.sample.map((t: { key: string }) => t.key), ['FX-2', 'FX-5'], 'a ticket with either label matches');

    // The tool has no assignee argument, so DevAgents filters by the ticket's assignee, which is an email there.
    const person = await s.call(`${one}/preview`, 'POST', { assignees: ['Sam Example', 'DevAgents Bot'] });
    assert.deepEqual(person.data.matches.sample.map((t: { key: string }) => t.key), ['FX-1', 'FX-2', 'FX-4']);
    assert.deepEqual(s.calls.at(-1)!.params!.arguments, { assignment: 'all' });
    assert.deepEqual(person.data.rule.assignees.map((a: { name: string }) => a.name), ['Sam Example', 'DevAgents Bot']);
    assert.equal((await s.call(`${one}/preview`, 'POST', { labels: ['feedback'] })).data.matches.total, 1);

    const saved = await s.call(`${one}/rule`, 'PUT', { projects: ['p-api'], columns: ['ready-for-development', 'todo'], start: 'auto' });
    assert.equal(saved.status, 200, saved.text); assert.equal(saved.data.matches.total, 1);
    const rule = saved.data.connections[0].rule;
    assert.deepEqual({ projects: rule.projects.map((p: { id: string; name: string }) => [p.id, p.name]), columns: rule.columns, start: rule.start, savedAt: rule.savedAt, assignees: rule.assignees, labels: rule.labels }, { projects: [['p-api', 'Backend API']], columns: ['ready-for-development', 'todo'], start: 'auto', savedAt: '2026-11-17T12:00:00.000Z', assignees: undefined, labels: undefined });
    assert.equal(s.f.store.project('fixture').integrations?.trackers?.[0]?.rule?.projects?.[0]?.id, 'p-api');
    // A rule can be removed while the tool stays connected; then no tickets come from it.
    const removed = await s.call(`${one}/rule`, 'DELETE');
    assert.equal(removed.status, 200); assert.equal(removed.data.connections.length, 1); assert.equal(removed.data.connections[0].rule, undefined);
    assert.deepEqual((await s.call('/tickets/available')).data.tickets, []);
    // A rule with nothing chosen can be saved too.
    assert.equal((await s.call(`${one}/rule`, 'PUT', {})).data.matches.total, 5);

    // The tool cannot be removed while the project uses it; disconnecting keeps the tool and drops the rule.
    const inUse = await s.call(`/trackers/${id}`, 'DELETE');
    assert.equal(inUse.status, 409); assert.match(inUse.data.message, /used by fixture/);
    assert.deepEqual((await s.call(one, 'DELETE')).data.connections, []);
    assert.equal((await s.call(`${one}/options`)).data.error, 'not_connected');
    assert.deepEqual((await s.call(`/trackers/${id}`, 'DELETE')).data.trackers, []);
    assert.equal((s.secrets as ReturnType<typeof memorySecrets>).values.size, 0, 'the token goes with the tool');
  } finally { await s.close(); }
});

test('a tool is checked, renamed and given a new token; a refused token shows on it and on its projects', async () => {
  const s = await serve();
  try {
    const id = await s.added(); const one = `${s.project}/${id}`; await s.call(one, 'PUT', {});
    assert.equal((await s.call(`/trackers/${id}/check`, 'POST', {})).data.state, 'connected');
    assert.equal((await s.call(`/trackers/${id}`, 'PUT', { name: 'Team board' })).data.name, 'Team board');
    assert.equal((await s.call(`/trackers/${id}`, 'PUT', {})).status, 400);
    // The address can be edited; a new one is tried first, so a wrong address leaves the working connection as it was.
    assert.equal((await s.call(`/trackers/${id}`, 'PUT', { url: 'http://tracker.fixture.invalid/mcp' })).data.error, 'invalid_site');
    assert.equal((await s.call(`/trackers/${id}`, 'PUT', { url: 'https://elsewhere.fixture.invalid/mcp' })).data.error, 'integration_unavailable');
    assert.equal((await s.call(`/trackers/${id}`)).data.url, URL_);
    const edited = await s.call(`/trackers/${id}`, 'PUT', { name: 'Team board', url: `${URL_}/`, token: TOKEN });
    assert.equal(edited.status, 200, edited.text); assert.equal(edited.data.url, URL_); assert.equal(edited.data.mapped, true, 'the mapping is kept');
    const wrong = await s.call(`/trackers/${id}`, 'PUT', { token: 'another-rejected-token' });
    assert.equal(wrong.data.error, 'token_rejected');
    assert.equal((s.secrets as ReturnType<typeof memorySecrets>).values.get('tracker-fixture-tracker'), TOKEN, 'the working token is kept when a new one is refused');

    s.state.revoked = true;
    const refused = await s.call(`/trackers/${id}/check`, 'POST', {});
    assert.equal(refused.status, 200); assert.equal(refused.data.state, 'rejected'); assert.equal(refused.data.problem.code, 'token_rejected');
    assert.equal((await s.call(s.project)).data.connections[0].tracker.state, 'rejected');
    assert.equal((await s.call(`${one}/options`)).data.error, 'token_rejected');
    s.state.revoked = false;
    assert.equal((await s.call(`/trackers/${id}`, 'PUT', { token: TOKEN })).data.state, 'connected');

    s.state.limited = true;
    const busy = await s.call(`${one}/options`);
    assert.equal(busy.status, 429); assert.match(busy.data.message, /Try again in 12 seconds/);
    s.state.limited = false;

    // Archiving a project drops its connection, like the GitHub and Jira ones.
    const project = s.f.store.project('fixture');
    assert.equal((await s.call('/projects/fixture/archive', 'POST', { archived: true, expectedVersion: project.version ?? 0 })).status, 200);
    assert.equal(s.f.store.project('fixture').integrations?.trackers, undefined);
    assert.deepEqual((await s.call(`/trackers/${id}`)).data.usedBy, []);
  } finally { await s.close(); }
});

test('an answer sent as an event stream is read the same way, and native installs take the token from the environment', async () => {
  const env: NodeJS.ProcessEnv = {};
  const s = await serve({ secrets: new EnvironmentSecretStore(env), state: { events: true } });
  try {
    const pasted = await s.call('/trackers', 'POST', { name: 'Fixture Tracker', url: URL_, token: TOKEN });
    assert.equal(pasted.data.error, 'vault_unconfigured'); assert.match(pasted.data.message, /DEVAGENTS_TRACKER_TOKEN_FIXTURE_TRACKER/);
    assert.equal(s.calls.length, 0, 'nothing is contacted when the token cannot be kept');
    assert.match((await s.call('/trackers', 'POST', { name: 'Fixture Tracker', url: URL_ })).data.message, /Set DEVAGENTS_TRACKER_TOKEN_FIXTURE_TRACKER/);
    env.DEVAGENTS_TRACKER_TOKEN_FIXTURE_TRACKER = TOKEN;
    const added = await s.call('/trackers', 'POST', { name: 'Fixture Tracker', url: URL_ });
    assert.equal(added.status, 201, added.text); assert.deepEqual(added.data.suggestion, MAPPING);
    assert.equal(added.data.tracker.variable, 'DEVAGENTS_TRACKER_TOKEN_FIXTURE_TRACKER');
  } finally { await s.close(); }
});

test('a project uses several tools, each with its own rule, and a tool added once serves several projects', async () => {
  const s = await serve();
  try {
    const board = await s.added('Team board'); const support = await s.added('Support desk');
    await s.call(`${s.project}/${board}`, 'PUT', {}); const both = await s.call(`${s.project}/${support}`, 'PUT', {});
    assert.deepEqual(both.data.connections.map((c: { tracker: { name: string } }) => c.tracker.name), ['Team board', 'Support desk']);
    await s.call(`${s.project}/${board}/rule`, 'PUT', { labels: ['devagents'] }); await s.call(`${s.project}/${support}/rule`, 'PUT', { columns: ['todo'], start: 'auto' });
    const rules = (await s.call(s.project)).data.connections.map((c: { rule: { labels?: string[]; columns?: string[]; start: string } }) => [(c.rule.labels ?? c.rule.columns)![0], c.rule.start]);
    assert.deepEqual(rules, [['devagents', 'manual'], ['todo', 'auto']], 'the rules do not touch each other');

    // A second project selects the tool that is already added: no address and no token are entered again.
    const path = `${s.f.root}/second`; execFileSync('git', ['clone', '-q', s.f.project, path]); await s.f.service.registerProject({ id: 'second', path });
    const before = (s.secrets as ReturnType<typeof memorySecrets>).values.size;
    const second = await s.call(`/projects/second/integrations/trackers/${board}`, 'PUT', {});
    assert.equal(second.status, 200, second.text); assert.equal(second.data.connections[0].rule, undefined, 'a rule belongs to one project');
    assert.equal((s.secrets as ReturnType<typeof memorySecrets>).values.size, before);
    assert.deepEqual((await s.call(`/trackers/${board}`)).data.usedBy.map((p: { id: string }) => p.id).sort(), ['fixture', 'second']);

    // Available tickets: what the rules match now, per project, without the ones that already have a task.
    const available = await s.call('/tickets/available');
    assert.equal(available.status, 200, available.text); assert.deepEqual(available.data.problems, []);
    const listed = available.data.tickets.map((t: { source: { name: string }; key: string; projectId: string; why: string; start: string }) => `${t.source.name}/${t.projectId}/${t.key}/${t.why}/${t.start}`);
    assert.deepEqual(listed, ['Team board/fixture/FX-1/label devagents/manual', 'Team board/fixture/FX-2/label devagents/manual', 'Team board/fixture/FX-3/label devagents/manual', 'Support desk/fixture/FX-5/todo/auto']);
    assert.equal(available.data.tickets[0].url, 'https://tracker.fixture.invalid/board?task=FX-1'); assert.equal(available.data.tickets[0].title, 'Add a contact form');
    await s.f.service.submit({ projectId: 'fixture', request: 'FX-2: Fix the footer links\n\nTicket: https://tracker.fixture.invalid/board?task=FX-2' }, 'available-start');
    assert.deepEqual((await s.call('/tickets/available')).data.tickets.map((t: { key: string }) => t.key), ['FX-1', 'FX-3', 'FX-5'], 'a ticket named by a task of the project is started');
    // Put back on the board: once the task was cancelled, or its pull request was closed without merging, the ticket can be started again.
    const started = s.f.store.summaries({ projectId: 'fixture' }).tasks.find(t => t.request.startsWith('FX-2'))!;
    const raw = new DatabaseSync(join(s.f.dataDir, 'test.db')); const stored = JSON.parse(String(raw.prepare('SELECT data FROM tasks WHERE id=?').get(started.id)!.data));
    const set = (state: string) => raw.prepare('UPDATE tasks SET state=?, data=? WHERE id=?').run(state, JSON.stringify({ ...stored, state }), started.id);
    const keys = async () => (await s.call('/tickets/available')).data.tickets.map((t: { key: string }) => t.key);
    set('cancelled'); assert.deepEqual(await keys(), ['FX-1', 'FX-2', 'FX-3', 'FX-5']);
    set('completed'); assert.deepEqual(await keys(), ['FX-1', 'FX-3', 'FX-5'], 'a finished task keeps its ticket');
    const pull = { number: 7, base: 'main', draft: false, headSha: 'a'.repeat(40), mergeable: 'unknown' as const, checks: [], comments: [] };
    s.f.store.savePullRequest(started.id, { ...pull, state: 'open', status: { code: 'ready', text: 'ready to merge' } }); assert.deepEqual(await keys(), ['FX-1', 'FX-3', 'FX-5']);
    s.f.store.savePullRequest(started.id, { ...pull, state: 'closed', status: { code: 'closed', text: 'closed without merging' } }); assert.deepEqual(await keys(), ['FX-1', 'FX-2', 'FX-3', 'FX-5']);
    s.f.store.savePullRequest(started.id, { ...pull, state: 'merged', status: { code: 'merged', text: 'merged into main' } }); assert.deepEqual(await keys(), ['FX-1', 'FX-3', 'FX-5']);
    raw.close();
    // A source that cannot be read is reported and does not hide the others.
    s.state.revoked = true;
    const broken = await s.call('/tickets/available');
    assert.equal(broken.status, 200); assert.deepEqual(broken.data.tickets, []); assert.equal(broken.data.problems.length, 2); assert.match(broken.data.problems[0].message, /did not accept this token/);
    s.state.revoked = false;

    // Disconnecting one tool keeps the other and its rule.
    const left = await s.call(`${s.project}/${board}`, 'DELETE');
    assert.deepEqual(left.data.connections.map((c: { tracker: { name: string }; rule: { columns: string[] } }) => [c.tracker.name, c.rule.columns[0]]), [['Support desk', 'todo']]);
    assert.equal((await s.call(`${s.project}/${board}/options`)).data.error, 'not_connected');
    assert.equal((await s.call(`/projects/second/integrations/trackers/${board}/options`)).status, 200);
  } finally { await s.close(); }
});


test('a ticket is read with its text, comments and file names, and a task started from it records the ticket', async () => {
  const s = await serve();
  try {
    const board = await s.added('Team board');
    const content = (key: string, source = board) => s.call(`/tickets/content?${new URLSearchParams({ projectId: 'fixture', source, key })}`);
    assert.equal((await content('FX-1')).data.error, 'not_connected', 'only a tool the project uses is read');
    await s.call(`${s.project}/${board}`, 'PUT', {}); await s.call(`${s.project}/${board}/rule`, 'PUT', { labels: ['devagents'] });
    const read = await content('FX-1');
    assert.equal(read.status, 200, read.text);
    assert.equal(read.data.request, [
      'FX-1: Add a contact form', 'Visitors cannot reach us from the site.', 'Add a contact form to the footer with name, email and message.',
      'Comments on the ticket:', 'sam@example.com, 2026-11-02:\nThe form should send to the support inbox.', 'agents@example.com, 2026-11-03:\nPlease keep it to three fields.\nSee the screenshot.',
      'Files on the ticket: footer.png, notes.txt, elsewhere.png', 'Ticket: https://tracker.fixture.invalid/board?task=FX-1',
    ].join('\n\n'));
    assert.deepEqual({ ...read.data.ticket, readAt: 0, comments: read.data.ticket.comments.length }, {
      source: board, name: 'Team board', key: 'FX-1', title: 'Add a contact form', url: 'https://tracker.fixture.invalid/board?task=FX-1', readAt: 0, comments: 2,
      description: 'Visitors cannot reach us from the site.\n\nAdd a contact form to the footer with name, email and message.',
      files: [{ name: 'footer.png', type: 'image/png', size: 68, kind: 'image' }, { name: 'notes.txt', type: 'text/plain', size: 27, kind: 'text' }, { name: 'elsewhere.png', type: 'image/png', size: 10, kind: 'image' }],
    });
    assert.ok(!read.text.includes('signature=fixture') && !read.text.includes(TOKEN), 'where the tool serves a file stays on the service');
    assert.deepEqual(s.calls.at(-1)!.params, { name: 'tracker_get_task', arguments: { taskId: 'FX-1' } });
    // A ticket with no comments or files is its title, text and link.
    assert.equal((await content('FX-3')).data.request, 'FX-3: Rate-limit the search API\n\nFixture ticket.\n\nTicket: https://tracker.fixture.invalid/board?task=FX-3');
    const missing = await content('FX-99'); assert.equal(missing.data.error, 'tracker_failed'); assert.match(missing.data.message, /FX-99 was not found/);
    assert.equal((await content('FX 1')).status, 400);
    // A mapping saved before reading existed names no read tool: it is found on the server.
    const { read: _, ...older } = MAPPING;
    assert.equal((await s.call(`/trackers/${board}/mapping`, 'PUT', older)).status, 200);
    assert.equal((await s.call(`/trackers/${board}`)).data.mapping.read, undefined);
    assert.equal((await content('FX-2')).data.ticket.title, 'Fix the footer links');
    assert.equal((await s.call(`/trackers/${board}/mapping`, 'PUT', { ...MAPPING, read: { tool: 'tracker_get_task', key: 'ticket' } })).data.error, 'invalid_mapping');

    // The task records where it came from; the ticket is then no longer available, whatever the request says.
    const task = s.f.service.submit({ projectId: 'fixture', request: 'Build the form as described.', ticket: { source: board, key: 'FX-1', url: read.data.ticket.url, readAt: read.data.ticket.readAt } }, 'from-ticket');
    assert.deepEqual(task.ticket, { source: board, name: 'Team board', key: 'FX-1', url: 'https://tracker.fixture.invalid/board?task=FX-1', readAt: read.data.ticket.readAt });
    assert.deepEqual(s.f.store.summaries({ projectId: 'fixture' }).tasks[0]!.ticket, task.ticket);
    assert.match(s.f.store.events(task.id)[0]!.reason, /started from Team board ticket FX-1/);
    assert.deepEqual((await s.call('/tickets/available')).data.tickets.map((t: { key: string; source: { id: string } }) => `${t.source.id === board}/${t.key}`), ['true/FX-2', 'true/FX-3']);
    assert.throws(() => s.f.service.submit({ projectId: 'fixture', request: 'x', ticket: { source: 'jira', key: 'WEB-1' } }, 'no-jira'), /Jira is not connected/);
    assert.throws(() => s.f.service.submit({ projectId: 'fixture', request: 'x', ticket: { source: '11111111-1111-4111-8111-111111111111', key: 'FX-1' } }, 'no-tool'), /not connected for this project/);
  } finally { await s.close(); }
});

test('starting a ticket assigns it to the account the tool is connected with, and a failure is recorded without stopping anything', async () => {
  const s = await serve();
  try {
    const id = await s.added(); await s.call(`${s.project}/${id}`, 'PUT', {});
    assert.deepEqual(suggestAssign(await new McpSession(fake.fakeTracker().fetcher as typeof fetch, { name: 'Fixture Tracker', url: URL_, token: TOKEN }).tools()), { tool: 'tracker_update_task', key: 'taskId', assignee: 'assignee', operation: 'operationId' });
    const notes: [string, any][] = []; const note = (kind: string, data: unknown) => { notes.push([kind, data]); };
    await assignStartedTicket({ trackers: s.trackers }, { id: 't', projectId: 'fixture', ticket: { source: id, key: 'FX-1' } }, note);
    assert.deepEqual(notes, [['ticket-assigned', { ticket: 'FX-1', source: 'Fixture Tracker', to: 'agents@example.com' }]]);
    const [update] = s.state.updates!;
    assert.equal(update!.taskId, 'FX-1'); assert.equal(update!.assignee, 'agents@example.com'); assert.match(String(update!.operationId), /^[0-9a-f-]{36}$/);
    assert.deepEqual(Object.keys(update!).sort(), ['assignee', 'operationId', 'taskId'], 'nothing else on the ticket is changed');
    await assignStartedTicket({ trackers: s.trackers }, { id: 't', projectId: 'fixture', ticket: { source: id, key: 'NOPE-1' } }, note);
    assert.equal(notes[1]![0], 'ticket-assign-failed'); assert.match(notes[1]![1].message, /was not found/);
    await assignStartedTicket({ trackers: s.trackers }, { id: 't', projectId: 'fixture' }, note);
    assert.equal(notes.length, 2, 'a task without a ticket assigns nothing');
  } finally { await s.close(); }
});
