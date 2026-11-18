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
// What only the single-ticket tool returns: the comments and the files of a ticket.
const details = {
  'FX-1': {
    description: 'Visitors cannot reach us from the site.\n\nAdd a contact form to the footer with name, email and message.',
    comments: [
      { id: 'c-1', by: 'sam@example.com', createdAt: '2026-11-02T09:15:00.000Z', body: 'The form should send to the support inbox.' },
      { id: 'c-2', by: 'agents@example.com', createdAt: '2026-11-03T14:40:00.000Z', body: 'Please keep it to three fields.\nSee the screenshot.' },
    ],
    attachments: [
      { id: 'a-1', name: 'footer.png', type: 'image/png', size: 68, uploadedAt: '2026-11-03T14:39:00.000Z', url: 'https://tracker.fixture.invalid/agent/tasks/task-1/attachments/a-1?signature=fixture' },
      { id: 'a-2', name: 'notes.txt', type: 'text/plain', size: 27, uploadedAt: '2026-11-03T14:39:30.000Z', url: 'https://tracker.fixture.invalid/agent/tasks/task-1/attachments/a-2?signature=fixture' },
      // A file on another host is never fetched: the token is only sent to the tool's own address.
      { id: 'a-3', name: 'elsewhere.png', type: 'image/png', size: 10, uploadedAt: '2026-11-03T14:39:40.000Z', url: 'https://files.fixture.invalid/elsewhere.png' },
    ],
  },
};
// A one-pixel PNG and a short text file, served like a tool serves a ticket's files.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const fileBodies = { 'a-1': { type: 'image/png', body: PNG }, 'a-2': { type: 'text/plain', body: Buffer.from('Three fields, no captcha.\n') } };
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
    const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...extra } });
    const file = /^https:\/\/tracker\.fixture\.invalid\/agent\/tasks\/task-1\/attachments\/(a-\d)\?signature=fixture$/.exec(url);
    if (file && fileBodies[file[1]]) {
      if (headers.authorization !== `Bearer ${FAKE_TRACKER_TOKEN}` || state.revoked) return json({ error: 'Authentication required' }, 401);
      return new Response(fileBodies[file[1]].body, { status: 200, headers: { 'content-type': fileBodies[file[1]].type } });
    }
    if (url !== FAKE_TRACKER_URL) throw new TypeError('fetch failed');
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
      if (name === 'tracker_get_task') {
        const found = tasks.find(t => t.key === args.taskId || t.id === args.taskId);
        if (!found) return answer({ isError: true, content: [{ type: 'text', text: `Ticket ${args.taskId} was not found.` }] });
        return answer({ content: [{ type: 'text', text: `${found.key}: ${found.title}` }], structuredContent: { ...found, comments: [], ...details[found.key] } });
      }
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
