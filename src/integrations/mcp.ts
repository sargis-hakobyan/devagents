import { AppError } from '../domain/errors.js';
import { list, record, remote, text, type Fetch } from './http.js';

/**
 * A small MCP client for the Streamable HTTP transport: enough to sign in with a bearer token, ask a
 * server which tools it has and call one. Everything a server sends is remote content; callers pick
 * the fields they need.
 */
export type McpAccess = { /** What the user calls the tool; used in messages. */ name: string; url: string; token: string };
export type McpProperty = { /** True when the server expects a list. */ many: boolean; /** Allowed values, when the server declares them. */ choices: string[] };
export type McpTool = { name: string; description: string; properties: Record<string, McpProperty> };

const PROTOCOL = '2025-06-18';
const MAX_TOOLS = 200;

/** Hosts that are this computer: the loopback names, and the name a Docker container uses for its host. */
const LOCAL_HOST = /^(?:localhost|[a-z0-9-]+\.localhost|127(?:\.\d{1,3}){3}|\[::1\]|host\.docker\.internal)$/i;
/**
 * One address without credentials, query or fragment, so a token is only ever sent to that address.
 * It must be https. Plain http is accepted only for a tool running on this computer, where the
 * token never leaves the machine.
 */
export function normalizeMcpUrl(input: string): string {
  const raw = input.trim(); let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`); }
  catch { throw new AppError('invalid_site', 'Enter the address of the tool\'s MCP server, for example https://tracker.example.com/mcp'); }
  const local = LOCAL_HOST.test(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new AppError('invalid_site', 'The address must use https, so the token is never sent unencrypted. Plain http is accepted only for a tool on this computer (localhost).');
  if (url.username || url.password || url.search || url.hash) throw new AppError('invalid_site', 'Enter only the address, without a user name, query or fragment');
  if (!local && !url.hostname.includes('.')) throw new AppError('invalid_site', 'Enter the full host name, for example tracker.example.com');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

type Message = { id?: unknown; result?: unknown; error?: unknown };
const answerTo = (value: unknown, id: number): Message | undefined => (Array.isArray(value) ? value : [value]).map(record).find(m => m.id === id && ('result' in m || 'error' in m));
/** A server may answer one request as a short event stream; the answer is the event that carries the request id. */
function fromEvents(body: string, id: number): Message | undefined {
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) continue;
    try { const found = answerTo(JSON.parse(data), id); if (found) return found; } catch { /* not a JSON event */ }
  }
  return;
}
function property(schema: unknown): McpProperty {
  const value = record(schema); const items = record(value.items);
  const type = Array.isArray(value.type) ? value.type[0] : value.type;
  const choices = list(value.enum).length ? list(value.enum) : list(items.enum);
  return { many: type === 'array', choices: choices.filter((c): c is string => typeof c === 'string').slice(0, 100) };
}

export class McpSession {
  private next = 0; private session: string | undefined; private protocol = PROTOCOL; private opened = false;
  constructor(private readonly fetcher: Fetch, private readonly access: McpAccess) {}

  private async send(method: string, params: Record<string, unknown> | undefined, notification = false): Promise<Record<string, unknown>> {
    const { name, url, token } = this.access; const id = ++this.next;
    const response = await remote(this.fetcher, name, url, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`,
        ...(method === 'initialize' ? {} : { 'mcp-protocol-version': this.protocol }), ...(this.session ? { 'mcp-session-id': this.session } : {}),
      },
      body: { jsonrpc: '2.0', ...(notification ? {} : { id }), method, ...(params ? { params } : {}) },
    });
    if (response.status === 401) throw new AppError('token_rejected', `${name} did not accept this token. Create a new one and replace it.`, 422);
    if (response.status === 403) throw new AppError('token_rejected', `${name} refused this account (403). Check that it may use the tool through an agent or API.`, 422);
    if (response.status === 429) {
      const seconds = Number(response.headers.get('retry-after'));
      throw new AppError('integration_busy', `${name} is limiting requests. Try again ${Number.isFinite(seconds) && seconds > 0 ? `in ${Math.ceil(seconds)} seconds` : 'in a minute'}.`, 429);
    }
    if (response.status === 404 || response.status === 405) throw new AppError('not_reachable', `No MCP server answers at ${url}. Check the address.`, 422);
    if (response.status >= 400) throw new AppError('not_reachable', `${name} answered ${response.status}. Check the address.`, 422);
    const session = response.headers.get('mcp-session-id');
    if (session && /^[\x21-\x7e]{1,200}$/.test(session)) this.session = session;
    if (notification) return {};
    const message = response.json === undefined ? fromEvents(response.body, id) : answerTo(response.json, id);
    if (!message) throw new AppError('not_reachable', `${url} did not answer like an MCP server. Check the address.`, 422);
    if (message.error !== undefined) throw new AppError('tracker_failed', `${name} reported: ${text(record(message.error).message) || 'an error without a message'}`, 502);
    return record(message.result);
  }

  /** Signs in and returns what the server calls itself. */
  async open(): Promise<{ name: string; version: string }> {
    const result = await this.send('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'devagents', version: '0.1.0' } });
    const protocol = text(result.protocolVersion, 20);
    if (/^\d{4}-\d{2}-\d{2}$/.test(protocol)) this.protocol = protocol;
    // Servers that keep no session ignore this; one that needs it answers every later call with an error.
    try { await this.send('notifications/initialized', undefined, true); } catch { /* reported by the next call if it matters */ }
    this.opened = true;
    const info = record(result.serverInfo);
    return { name: text(info.title, 80) || text(info.name, 80) || 'MCP server', version: text(info.version, 40) };
  }

  async tools(): Promise<McpTool[]> {
    if (!this.opened) await this.open();
    const found: McpTool[] = []; let cursor: string | undefined;
    for (let page = 0; page < 10 && found.length < MAX_TOOLS; page++) {
      const result = await this.send('tools/list', cursor ? { cursor } : undefined);
      for (const item of list(result.tools).map(record)) {
        const name = typeof item.name === 'string' ? item.name : '';
        if (!/^[A-Za-z0-9_.\-/]{1,128}$/.test(name)) continue;
        const properties = Object.entries(record(record(item.inputSchema).properties)).filter(([key]) => /^[A-Za-z0-9_.\-/]{1,128}$/.test(key)).slice(0, 60);
        found.push({ name, description: text(item.description, 300), properties: Object.fromEntries(properties.map(([key, schema]) => [key, property(schema)])) });
      }
      cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return found.slice(0, MAX_TOOLS);
  }

  /** Calls one tool and returns its structured answer. A tool that answers only with prose cannot be used. */
  async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.opened) await this.open();
    const result = await this.send('tools/call', { name: tool, arguments: args });
    const prose = list(result.content).map(record).filter(part => part.type === 'text').map(part => typeof part.text === 'string' ? part.text : '');
    if (result.isError === true) throw new AppError('tracker_failed', `${this.access.name} could not run ${tool}: ${text(prose.join(' ')) || 'no reason given'}`, 502);
    if (result.structuredContent !== undefined && result.structuredContent !== null) return result.structuredContent;
    for (const part of prose) { try { const value: unknown = JSON.parse(part); if (value && typeof value === 'object') return value; } catch { /* prose */ } }
    throw new AppError('tracker_failed', `${tool} answered with text only. DevAgents needs a tool that returns structured data.`, 502);
  }
}
