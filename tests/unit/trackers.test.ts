import test from 'node:test';
import assert from 'node:assert/strict';
import { McpSession, normalizeMcpUrl } from '../../src/integrations/mcp.js';
import { choice, listArguments, matches, shapeOf, suggestColumns, suggestFields, suggestList, tickets } from '../../src/integrations/tracker-mapping.js';
import { TrackerMapping, TrackerRuleInput } from '../../src/domain/trackers.js';
import { AppError } from '../../src/domain/errors.js';

test('an MCP address becomes one https address and unsafe forms are refused', () => {
  assert.equal(normalizeMcpUrl('tracker.example.com/mcp/'), 'https://tracker.example.com/mcp');
  assert.equal(normalizeMcpUrl(' https://tracker.example.com/mcp '), 'https://tracker.example.com/mcp');
  // Plain http only for a tool on this computer, including the host as a Docker container sees it.
  for (const url of ['http://localhost:3004/mcp', 'http://127.0.0.1:3004/mcp', 'http://[::1]:3004/mcp', 'http://board.localhost/mcp', 'http://host.docker.internal:3004/mcp', 'https://localhost/mcp']) assert.equal(normalizeMcpUrl(url), url);
  for (const url of ['http://tracker.example.com/mcp', 'http://staging.tracker.example.com/mcp', 'http://localhost.example.com/mcp', 'http://192.168.1.20/mcp', 'http://10.0.0.5/mcp', 'ftp://localhost/mcp', 'https://user:pass@tracker.example.com/mcp', 'https://tracker.example.com/mcp?key=1', 'https://intranet/mcp', 'not a host']) {
    assert.throws(() => normalizeMcpUrl(url), (error: unknown) => error instanceof AppError && error.code === 'invalid_site', url);
  }
});

/** A server that answers each JSON-RPC method from a table. */
function server(answers: Record<string, (params: Record<string, any>) => unknown>, headers: Record<string, string> = {}) {
  const seen: { method: string; session: string | undefined; protocol: string | undefined }[] = [];
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body)) as { id?: number; method: string; params?: Record<string, any> }; const sent = init!.headers as Record<string, string>;
    seen.push({ method: body.method, session: sent['mcp-session-id'], protocol: sent['mcp-protocol-version'] });
    if (body.id === undefined) return new Response(null, { status: 202 });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: answers[body.method]!(body.params ?? {}) }), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
  }) as typeof fetch;
  return { fetcher, seen };
}
const access = { name: 'Board', url: 'https://tracker.example.com/mcp', token: 'fixture-token-0001' };

test('an MCP session keeps the server\'s session and protocol, and refuses answers it cannot use', async () => {
  const { fetcher, seen } = server({
    initialize: () => ({ protocolVersion: '2025-03-26', serverInfo: { name: 'board', version: '2.0.0' } }),
    'tools/list': () => ({ tools: [{ name: 'list_issues', description: 'Lists\nissues', inputSchema: { properties: { state: { type: 'string', enum: ['open', 'closed'] }, tags: { type: ['array', 'null'], items: { type: 'string' } }, 'bad name': {} } } }, { name: 'bad name' }] }),
    'tools/call': params => params.name === 'prose' ? { content: [{ type: 'text', text: 'Three issues are open.' }] }
      : params.name === 'text_json' ? { content: [{ type: 'text', text: '{"issues":[]}' }] }
      : params.name === 'fails' ? { isError: true, content: [{ type: 'text', text: 'No access to that board' }] } : { structuredContent: { issues: [] } },
  }, { 'mcp-session-id': 'session-1' });
  const session = new McpSession(fetcher, access);
  assert.deepEqual(await session.open(), { name: 'board', version: '2.0.0' });
  assert.deepEqual(await session.tools(), [{ name: 'list_issues', description: 'Lists issues', properties: { state: { many: false, choices: ['open', 'closed'] }, tags: { many: true, choices: [] } } }]);
  assert.deepEqual(seen.map(s => s.method), ['initialize', 'notifications/initialized', 'tools/list']);
  assert.deepEqual(seen[2], { method: 'tools/list', session: 'session-1', protocol: '2025-03-26' });
  assert.deepEqual(await session.call('list_issues', {}), { issues: [] });
  assert.deepEqual(await session.call('text_json', {}), { issues: [] }, 'older servers put the data in a text part');
  await assert.rejects(session.call('prose', {}), /answered with text only/);
  await assert.rejects(session.call('fails', {}), /could not run fails: No access to that board/);
});

test('a mapping is proposed for a tool with its own vocabulary', () => {
  const tools = [
    { name: 'get_issue', description: '', properties: { id: { many: false, choices: [] } } },
    { name: 'search_issues', description: '', properties: { team: { many: false, choices: [] }, state: { many: false, choices: [] }, tags: { many: true, choices: [] }, owner: { many: false, choices: [] }, scope: { many: false, choices: ['mine', 'all'] } } },
    { name: 'move_issue', description: '', properties: { state: { many: false, choices: ['Triage', 'Doing', 'Shipped'] } } },
  ];
  const list = suggestList(tools);
  assert.deepEqual(list, { tool: 'search_issues', fixed: { scope: 'all' }, filters: { project: { name: 'team', many: false }, column: { name: 'state', many: false }, label: { name: 'tags', many: true }, assignee: { name: 'owner', many: false } } });
  assert.deepEqual(suggestColumns(tools), ['Triage', 'Doing', 'Shipped']);
  assert.equal(suggestList([{ name: 'get_weather', description: '', properties: {} }]), undefined);

  const answer = { data: { issues: [{ identifier: 'ENG-7', summary: 'Crash on save', state: 'Doing', project: { id: 'eng', name: 'Engineering' }, assignee: { email: 'sam@example.com', name: 'Sam' }, tags: [{ name: 'bug' }], link: 'https://board.example.com/ENG-7' }], teams: [{ id: 'eng', name: 'Engineering' }], members: [{ id: 'm1', email: 'sam@example.com', name: 'Sam' }], me: { name: 'Bot' } } };
  const shape = shapeOf(answer);
  assert.ok(!JSON.stringify(shape).includes('Crash on save'), 'the outline carries field names, never values');
  const fields = suggestFields(shape);
  assert.deepEqual(fields, {
    result: { tickets: 'data.issues', projects: 'data.teams', people: 'data.members', account: 'data.me' },
    ticket: { key: 'identifier', title: 'summary', column: 'state', project: 'project', assignee: 'assignee', labels: 'tags', url: 'link' },
  });
  const mapping = TrackerMapping.parse({ list, ...fields });
  assert.deepEqual(tickets(mapping, answer), [{ key: 'ENG-7', title: 'Crash on save', column: 'Doing', project: 'eng', assignee: 'sam@example.com', labels: ['bug'], url: 'https://board.example.com/ENG-7' }]);
  assert.equal(suggestFields(shapeOf({ message: 'hello', counts: [1, 2] })), undefined);
});

test('rule values go to the tool where it filters and are checked on the tickets where it does not', () => {
  const mapping = TrackerMapping.parse({ list: { tool: 'list', fixed: { scope: 'all' }, filters: { column: { name: 'states', many: true } } }, result: { tickets: 'items' }, ticket: { key: 'id', title: 'name', column: 'state', assignee: 'owner', labels: 'tags' } });
  const sam = choice({ id: 'u1', email: 'Sam@Example.com', name: 'Sam' })!;
  assert.deepEqual(sam, { id: 'u1', name: 'Sam', match: ['u1', 'sam@example.com', 'sam'] });
  assert.deepEqual(listArguments(mapping, { columns: ['Doing'], assignees: [sam], labels: ['bug'] }), { scope: 'all', states: ['Doing'] });
  assert.deepEqual(listArguments(mapping, { columns: ['Doing', 'Review'] }), { scope: 'all', states: ['Doing', 'Review'] }, 'several columns use the tool\'s list');
  assert.deepEqual(listArguments(mapping, {}), { scope: 'all' });
  const [mine, other] = tickets(mapping, { items: [{ id: 1, name: 'A', state: 'doing', owner: 'sam@example.com', tags: ['Bug'] }, { id: 2, name: 'B', state: 'Doing', owner: 'kim@example.com', tags: [] }, { name: 'no id' }, { id: 4, name: 'C', link: 'javascript:alert(1)' }] });
  assert.equal(matches(mapping, mine!, { columns: ['Doing'], assignees: [sam], labels: ['bug'] }), true);
  assert.equal(matches(mapping, mine!, { columns: ['Review', 'DOING'], labels: ['feature', 'bug'] }), true, 'any value of a part matches');
  assert.equal(matches(mapping, other!, { columns: ['Doing'], assignees: [sam] }), false, 'every filled part must match');
  assert.equal(matches(mapping, other!, { labels: ['bug'] }), false);
  assert.equal(matches(mapping, other!, {}), true, 'an empty rule matches every ticket');
  // A single-value argument cannot carry several columns, so they are left to the ticket check.
  const single = TrackerMapping.parse({ list: { tool: 'list', filters: { column: { name: 'state', many: false } } }, result: { tickets: 'items' }, ticket: { key: 'id', title: 'name', column: 'state' } });
  assert.deepEqual(listArguments(single, { columns: ['Doing'] }), { state: 'Doing' }); assert.deepEqual(listArguments(single, { columns: ['Doing', 'Review'] }), {});
});

test('tracker input is strict', () => {
  assert.equal(TrackerRuleInput.safeParse({ project: 'Website' }).success, false, 'single-value names are not part of a rule');
  assert.deepEqual(TrackerRuleInput.parse({}), { start: 'manual' }, 'every part is optional');
  assert.deepEqual(TrackerRuleInput.parse({ labels: [' devagents ', 'devagents', 'bug'] }), { labels: ['devagents', 'bug'], start: 'manual' });
  assert.equal(TrackerMapping.safeParse({ list: { tool: 'list' }, result: { tickets: 'a..b' }, ticket: { key: 'id', title: 'name' } }).success, false);
  assert.equal(TrackerMapping.safeParse({ list: { tool: 'list', extra: 1 }, result: { tickets: 'items' }, ticket: { key: 'id', title: 'name' } }).success, false);
  assert.equal(TrackerMapping.safeParse({ list: { tool: 'list' }, result: { tickets: 'items' }, ticket: { key: 'id', title: 'name' } }).success, true);
});
