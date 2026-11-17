// DEVELOPMENT FIXTURE — not for production use.
// A deterministic ticket tool with an MCP server, as a fetch function. It is shared by the tests and
// the browser fixture, so both exercise the same made-up tool. It is modelled on no real product.
export const FAKE_TRACKER_URL = 'https://tracker.fixture.invalid/mcp';
export const FAKE_TRACKER_TOKEN = 'fixture-tracker-token-0001';

const projects = [{ id: 'p-web', name: 'Website', color: '#2563eb' }, { id: 'p-api', name: 'Backend API', color: '#16a34a' }];
const users = [{ id: 'u-sam', email: 'sam@example.com', name: 'Sam Example' }, { id: 'u-bot', email: 'agents@example.com', name: 'DevAgents Bot' }];
const labels = [{ id: 'devagents', name: 'devagents', color: '#16a34a' }, { id: 'bug', name: 'bug', color: '#dc2626' }];
const statuses = ['backlog', 'todo', 'ready-for-development', 'in-progress', 'done'];
const task = (number, title, status, projectId, assignee, taskLabels) => ({
  id: `task-${number}`, key: `FX-${number}`, title, status, projectId, projectName: projects.find(p => p.id === projectId).name,
  ...(assignee ? { assignee } : {}), labels: taskLabels, description: 'Fixture ticket.', url: `https://tracker.fixture.invalid/board?task=FX-${number}`,
});
const tasks = [
  task(1, 'Add a contact form', 'ready-for-development', 'p-web', 'agents@example.com', ['devagents']),
  task(2, 'Fix the footer links', 'ready-for-development', 'p-web', 'sam@example.com', ['devagents', 'bug']),
  task(3, 'Rate-limit the search API', 'ready-for-development', 'p-api', undefined, ['devagents']),
  task(4, 'Rework the landing page', 'in-progress', 'p-web', 'sam@example.com', []),
  // A label that is on a ticket but not in the label list, as integrations in real tools produce.
  task(5, 'Feedback: the menu is hard to find', 'todo', 'p-web', undefined, ['feedback']),
];
const text = { type: 'string' };
const tools = [
  { name: 'tracker_list_work', description: 'Lists visible tickets. Defaults to the caller\'s own tickets.', inputSchema: { type: 'object', properties: { assignment: { type: 'string', enum: ['mine', 'all'] }, projectId: text, statuses: { type: 'array', items: text }, labels: { type: 'array', items: text } } } },
  { name: 'tracker_get_task', description: 'Returns one ticket by key.', inputSchema: { type: 'object', properties: { taskId: text } } },
  { name: 'tracker_update_task', description: 'Updates one ticket.', inputSchema: { type: 'object', properties: { taskId: text, status: { type: 'string', enum: statuses }, labels: { type: 'array', items: text } } } },
];

/**
 * @param {{ revoked?: boolean; events?: boolean; limited?: boolean }} state `events` answers as an event stream instead of plain JSON.
 */
export function fakeTracker(state = {}) {
  const calls = [];
  const fetcher = async (input, init = {}) => {
    const url = String(input); const headers = init.headers ?? {}; const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, authorization: headers.authorization, method: body?.method, params: body?.params, redirect: init.redirect });
    if (url !== FAKE_TRACKER_URL) throw new TypeError('fetch failed');
    const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...extra } });
    if (headers.authorization !== `Bearer ${FAKE_TRACKER_TOKEN}` || state.revoked) return json({ error: 'Authentication required' }, 401);
    if (state.limited) return json({ error: 'Too many agent requests' }, 429, { 'retry-after': '12' });
    if (body.id === undefined) return new Response(null, { status: 202 });
    const answer = result => {
      const message = { jsonrpc: '2.0', id: body.id, result };
      return state.events ? new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } }) : json(message);
    };
    if (body.method === 'initialize') return answer({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture-tracker', title: 'Fixture Tracker', version: '1.2.0' } });
    if (body.method === 'tools/list') return answer({ tools });
    if (body.method === 'tools/call') {
      const { name, arguments: args = {} } = body.params;
      if (name !== 'tracker_list_work') return answer({ isError: true, content: [{ type: 'text', text: `Unknown tool ${name}` }] });
      const found = tasks.filter(t => (args.assignment ?? 'mine') === 'all' || t.assignee === 'agents@example.com')
        .filter(t => !args.projectId || t.projectId === args.projectId)
        .filter(t => !args.statuses || args.statuses.includes(t.status))
        .filter(t => (args.labels ?? []).every(l => t.labels.includes(l)));
      return answer({ content: [{ type: 'text', text: `${found.length} visible tickets.` }], structuredContent: { projects, tasks: found, users, labels, viewer: { email: 'agents@example.com' } } });
    }
    return json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } });
  };
  return { fetcher, calls };
}
