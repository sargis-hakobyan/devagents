import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { createApi } from '../../src/api/server.js';
import { TrackerService } from '../../src/integrations/trackers.js';
import { EnvironmentSecretStore, type SecretStore } from '../../src/security/secret-store.js';
import { fixture } from '../helpers.js';

type Call = { url: string; authorization?: string; method?: string; params?: { name?: string; arguments?: Record<string, unknown> }; redirect?: string };
type Fake = { fetcher: typeof fetch; calls: Call[] };
const fake = await import('../../scripts/fake-tracker.mjs' as string) as { FAKE_TRACKER_URL: string; FAKE_TRACKER_TOKEN: string; fakeTracker(state?: { revoked?: boolean; events?: boolean; limited?: boolean }): Fake };
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
};
async function serve(options: { secrets?: SecretStore; state?: { revoked?: boolean; events?: boolean; limited?: boolean } } = {}) {
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
  return { f, root, secrets, state, calls, call, added, project: '/projects/fixture/integrations/trackers', close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.cleanup(); } };
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

    assert.equal((await s.call(`${one}/preview`, 'POST', { project: 'Website' })).status, 400, 'a rule cannot mean every ticket');
    assert.match((await s.call(`${one}/preview`, 'POST', { column: 'Ready' })).data.message, /no column "Ready". Available: backlog, todo/);
    assert.match((await s.call(`${one}/preview`, 'POST', { project: 'Shop', label: 'devagents' })).data.message, /no project "Shop". Available: Website, Backend API/);

    const preview = await s.call(`${one}/preview`, 'POST', { project: 'website', column: 'Ready-For-Development', label: 'devagents' });
    assert.equal(preview.status, 200, preview.text);
    assert.deepEqual(preview.data.matches, { total: 2, sample: [{ key: 'FX-1', title: 'Add a contact form', url: 'https://tracker.fixture.invalid/board?task=FX-1' }, { key: 'FX-2', title: 'Fix the footer links', url: 'https://tracker.fixture.invalid/board?task=FX-2' }] });
    assert.deepEqual(s.calls.at(-1)!.params!.arguments, { assignment: 'all', projectId: 'p-web', statuses: ['ready-for-development'], labels: ['devagents'] }, 'mapped filters are sent to the tool');
    assert.equal((await s.call(s.project)).data.connections[0].rule, undefined, 'a preview saves nothing');

    // The tool has no assignee argument, so DevAgents filters by the ticket's assignee, which is an email there.
    const person = await s.call(`${one}/preview`, 'POST', { assignee: 'Sam Example' });
    assert.deepEqual(person.data.matches.sample.map((t: { key: string }) => t.key), ['FX-2', 'FX-4']);
    assert.deepEqual(s.calls.at(-1)!.params!.arguments, { assignment: 'all' });
    assert.deepEqual(person.data.rule.assignee.name, 'Sam Example');
    assert.equal((await s.call(`${one}/preview`, 'POST', { label: 'feedback' })).data.matches.total, 1);

    const saved = await s.call(`${one}/rule`, 'PUT', { project: 'p-api', column: 'ready-for-development', start: 'auto' });
    assert.equal(saved.status, 200, saved.text); assert.equal(saved.data.matches.total, 1);
    assert.deepEqual({ ...saved.data.connections[0].rule, project: { id: 'p-api', name: 'Backend API' } }, { project: { id: 'p-api', name: 'Backend API' }, column: 'ready-for-development', start: 'auto', savedAt: '2026-11-17T12:00:00.000Z' });
    assert.equal(s.f.store.project('fixture').integrations?.trackers?.[0]?.rule?.project?.id, 'p-api');

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
    await s.call(`${s.project}/${board}/rule`, 'PUT', { label: 'devagents' }); await s.call(`${s.project}/${support}/rule`, 'PUT', { column: 'todo', start: 'auto' });
    const rules = (await s.call(s.project)).data.connections.map((c: { rule: { label?: string; column?: string; start: string } }) => [c.rule.label ?? c.rule.column, c.rule.start]);
    assert.deepEqual(rules, [['devagents', 'manual'], ['todo', 'auto']], 'the rules do not touch each other');

    // A second project selects the tool that is already added: no address and no token are entered again.
    const path = `${s.f.root}/second`; execFileSync('git', ['clone', '-q', s.f.project, path]); await s.f.service.registerProject({ id: 'second', path });
    const before = (s.secrets as ReturnType<typeof memorySecrets>).values.size;
    const second = await s.call(`/projects/second/integrations/trackers/${board}`, 'PUT', {});
    assert.equal(second.status, 200, second.text); assert.equal(second.data.connections[0].rule, undefined, 'a rule belongs to one project');
    assert.equal((s.secrets as ReturnType<typeof memorySecrets>).values.size, before);
    assert.deepEqual((await s.call(`/trackers/${board}`)).data.usedBy.map((p: { id: string }) => p.id).sort(), ['fixture', 'second']);

    // Disconnecting one tool keeps the other and its rule.
    const left = await s.call(`${s.project}/${board}`, 'DELETE');
    assert.deepEqual(left.data.connections.map((c: { tracker: { name: string }; rule: { column: string } }) => [c.tracker.name, c.rule.column]), [['Support desk', 'todo']]);
    assert.equal((await s.call(`${s.project}/${board}/options`)).data.error, 'not_connected');
    assert.equal((await s.call(`/projects/second/integrations/trackers/${board}/options`)).status, 200);
  } finally { await s.close(); }
});

