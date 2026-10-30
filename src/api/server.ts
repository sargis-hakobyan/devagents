import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { z, ZodError } from 'zod';
import type { TaskService } from '../orchestration/service.js';
import { AppError } from '../domain/errors.js';
import { Id, State, TeamId } from '../domain/schemas.js';
import { environmentSecrets, redactValues, log } from '../telemetry/redact.js';
import { BrowserSessions, SESSION_COOKIE, parseCookies, sessionCookie, clearedSessionCookie, type BrowserSession } from './session.js';
import { securityHeaders, serveUi } from './static.js';
import { evidenceMetadata } from './evidence.js';

export async function accessToken(dataDir: string): Promise<string> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  // A pre-existing, more permissive data directory is tightened on every start; the token inside is 0600.
  await chmod(dataDir, 0o700);
  const path = join(dataDir, 'api-token');
  try { await writeFile(path, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await chmod(path, 0o600);
  return (await readFile(path, 'utf8')).trim();
}
async function body(req: IncomingMessage): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError('invalid_content_type', 'Use application/json', 415);
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 256 * 1024) throw new AppError('body_too_large', 'Request exceeds 256KB', 413);
    chunks.push(chunk as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AppError('invalid_json', 'Invalid JSON request'); }
}
function respond(res: ServerResponse, code: number, data: unknown, extra: Record<string, string>, secrets: readonly string[]): void {
  res.writeHead(code, { ...securityHeaders, 'content-type': 'application/json', 'cache-control': 'no-store', ...extra });
  // Stored rows are already redacted at rest; responses only strip secret values so plans stay readable.
  res.end(JSON.stringify(redactValues(data, secrets)));
}
const EVIDENCE_PREVIEW_BYTES = 16 * 1024; const EVIDENCE_ENTRY_BYTES = 1024 * 1024;
/** List payloads carry a bounded preview of each evidence entry; the single-entry route carries up to 1 MiB. */
function boundEvidence(entry: { sequence: number; kind: string; at: string; data: unknown }, limit: number) {
  const json = JSON.stringify(entry.data ?? null);
  if (Buffer.byteLength(json) <= limit) return entry;
  return { sequence: entry.sequence, kind: entry.kind, at: entry.at, metadata: evidenceMetadata(entry.data), data: { preview: Buffer.from(json).subarray(0, limit).toString('utf8'), bytes: Buffer.byteLength(json) }, truncated: true };
}
const integer = (value: string | null, fallback: number) => { const n = Number(value ?? fallback); return Number.isInteger(n) && n >= 0 ? n : fallback; };

export type ApiOptions = {
  sessions?: BrowserSessions;
  uiRoot?: string | undefined;
  status?: () => Promise<unknown>;
  secureCookies?: boolean;
  /**
   * The port the browser reaches the service on. In Docker the service listens on 4310 but Compose
   * publishes a host port, so the Host allowlist and sign-in links must use the published one.
   * Defaults to the listening port.
   */
  publicPort?: number | undefined;
  /** Host header values that may carry a browser session; defaults to loopback names on the public port. */
  allowedHosts?: (port: number) => string[];
};
type Principal = { kind: 'bearer' } | { kind: 'session'; session: BrowserSession };

export function createApi(service: TaskService, token: string, options: ApiOptions = {}) {
  const sessions = options.sessions ?? new BrowserSessions();
  // Responses use the store's secret list (environment heuristic plus configured provider keys), the same list applied at rest.
  const secrets = [...new Set([...environmentSecrets(), ...service.store.secrets])];
  const send = (res: ServerResponse, code: number, data: unknown, extra: Record<string, string> = {}) => respond(res, code, data, extra, secrets);
  const allowedHosts = (port: number) => (options.allowedHosts ?? (p => ['127.0.0.1', 'localhost', '[::1]'].map(h => `${h}:${p}`)))(port);
  const publicPort = (req: IncomingMessage) => options.publicPort ?? req.socket.localPort ?? 0;
  /**
   * Bearer requests keep the original contract: any Origin header is refused, so the CLI path never
   * serves a browser. Cookie requests must come from the same origin on an allowed loopback host and,
   * for state-changing methods, carry the session's CSRF token.
   */
  const authenticate = (req: IncomingMessage): Principal => {
    if (req.headers.authorization !== undefined) {
      if (req.headers.origin) throw new AppError('forbidden_origin', 'Browser requests are not enabled on the bearer path', 403);
      const supplied = Buffer.from(req.headers.authorization); const expected = Buffer.from(`Bearer ${token}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new AppError('unauthorized', 'Use the local CLI or a valid bearer token', 401);
      return { kind: 'bearer' };
    }
    const cookie = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
    if (!cookie) throw new AppError('unauthorized', 'Sign in to the browser UI with the link from: devagents ui', 401);
    const host = (req.headers.host ?? '').toLowerCase();
    if (!allowedHosts(publicPort(req)).includes(host)) throw new AppError('forbidden_host', 'Browser sessions are only accepted on the local loopback host and published port', 403);
    if (req.headers.origin !== undefined && req.headers.origin !== `http://${host}` && req.headers.origin !== `https://${host}`) throw new AppError('forbidden_origin', 'Cross-origin browser requests are not allowed', 403);
    const site = req.headers['sec-fetch-site'];
    if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') throw new AppError('forbidden_origin', 'Cross-site browser requests are not allowed', 403);
    const session = sessions.get(cookie);
    if (!session) throw new AppError('session_expired', 'Your browser session has ended; create a new link with: devagents ui', 401);
    if (!['GET', 'HEAD'].includes(req.method ?? '') && !sessions.verifyCsrf(session, req.headers['x-csrf-token'] as string | undefined)) throw new AppError('csrf_required', 'State-changing requests need the session CSRF token', 403);
    return { kind: 'session', session };
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost'); const path = url.pathname;
      if (req.method === 'GET' && path === '/health') return send(res, 200, { status: 'ok', milestone: 'M3', ui: Boolean(options.uiRoot), executionEnabled: service.executionEnabled });
      if (req.method === 'GET' && path === '/') { res.writeHead(302, { ...securityHeaders, location: '/ui/' }); return res.end(); }
      if (req.method === 'GET' && path === '/ui/login') {
        const session = sessions.exchange(url.searchParams.get('code') ?? '');
        if (!session) throw new AppError('invalid_login_code', 'This sign-in link is invalid, expired or already used; create a new one with: devagents ui', 403);
        res.writeHead(303, { ...securityHeaders, 'set-cookie': sessionCookie(session.id, Boolean(options.secureCookies)), location: '/ui/', 'cache-control': 'no-store' }); return res.end();
      }
      if (req.method === 'GET' && (path === '/ui' || (path.startsWith('/ui/') && !['/ui/session', '/ui/logout', '/ui/bootstrap'].includes(path)))) return serveUi(options.uiRoot, path, res);
      const principal = authenticate(req);
      if (path === '/ui/bootstrap' && req.method === 'POST') {
        if (principal.kind !== 'bearer') throw new AppError('bearer_required', 'Sign-in links are created through the CLI', 403);
        return send(res, 201, { url: `http://127.0.0.1:${publicPort(req)}/ui/login?code=${sessions.mintCode()}`, expiresInSeconds: 600, singleUse: true });
      }
      if (path === '/ui/session' && req.method === 'GET') {
        if (principal.kind !== 'session') throw new AppError('session_required', 'Only browser sessions have a CSRF token', 403);
        return send(res, 200, { authenticated: true, csrfToken: principal.session.csrfToken, expiresAt: new Date(sessions.expiresAt(principal.session)).toISOString() });
      }
      if (path === '/ui/logout' && req.method === 'POST') {
        if (principal.kind !== 'session') throw new AppError('session_required', 'Only browser sessions can sign out', 403);
        sessions.destroy(principal.session.id);
        return send(res, 200, { signedOut: true }, { 'set-cookie': clearedSessionCookie(Boolean(options.secureCookies)) });
      }
      if (req.method === 'GET' && path === '/submission-options') return send(res, 200, service.submissionOptions());
      if (req.method === 'GET' && path === '/projects') return send(res, 200, service.store.projects());
      if (req.method === 'POST' && path === '/projects') return send(res, 201, await service.registerProject(await body(req)));
      if (req.method === 'GET' && path === '/agents') return send(res, 200, await service.agents(url.searchParams.get('projectId') ?? undefined));
      const projectDefault = /^\/projects\/([a-z][a-z0-9-]{0,63})\/default-team$/.exec(path);
      if (req.method === 'PUT' && projectDefault) {
        const change = z.strictObject({ teamId: TeamId.nullable(), expectedVersion: z.number().int().nonnegative() }).parse(await body(req));
        return send(res, 200, service.setProjectDefaultTeam(projectDefault[1]!, change.teamId, change.expectedVersion));
      }
      // Saved teams: every mutation is behind the same authentication, CSRF and origin checks as task actions.
      if (req.method === 'GET' && path === '/teams') return send(res, 200, service.teams(z.enum(['active', 'archived', 'all']).parse(url.searchParams.get('filter') ?? 'active')));
      if (req.method === 'POST' && path === '/teams') return send(res, 201, service.createTeam(await body(req)));
      if (req.method === 'POST' && path === '/teams/check') return send(res, 200, service.checkTeam(await body(req)));
      if (req.method === 'GET' && path === '/teams/options') return send(res, 200, service.teamOptions());
      if (req.method === 'GET' && path === '/teams/templates') return send(res, 200, await service.templates(url.searchParams.get('projectId') ?? undefined));
      const teamMatch = /^\/teams\/([a-f0-9-]{36})(?:\/(archive|duplicate))?$/.exec(path);
      if (teamMatch) {
        const id = teamMatch[1]!; const action = teamMatch[2];
        if (req.method === 'GET' && !action) return send(res, 200, service.team(id));
        if (req.method === 'PUT' && !action) {
          const change = z.strictObject({ expectedRevision: z.number().int().positive(), team: z.unknown() }).parse(await body(req));
          return send(res, 200, service.updateTeam(id, change.expectedRevision, change.team));
        }
        if (req.method === 'POST' && action === 'archive') {
          const change = z.strictObject({ expectedRevision: z.number().int().positive(), archived: z.boolean() }).parse(await body(req));
          return send(res, 200, service.setTeamArchived(id, change.expectedRevision, change.archived));
        }
        if (req.method === 'POST' && action === 'duplicate') return send(res, 201, service.duplicateTeam(id, z.strictObject({ name: z.unknown() }).parse(await body(req)).name));
      }
      if (req.method === 'GET' && path === '/overview') return send(res, 200, service.store.overview());
      if (req.method === 'GET' && path === '/status') {
        if (!options.status) throw new AppError('not_found', 'Status reporting is not configured', 404);
        return send(res, 200, await options.status());
      }
      if (req.method === 'GET' && path === '/tasks') {
        const states = z.array(State).max(State.options.length).parse(url.searchParams.getAll('state'));
        const project = url.searchParams.get('projectId'); const projectId = project ? Id.parse(project) : undefined;
        const before = url.searchParams.get('before');
        return send(res, 200, { ...service.store.summaries({
          limit: integer(url.searchParams.get('limit'), 50),
          ...(before ? { before: integer(before, 0) } : {}),
          ...(projectId ? { projectId } : {}),
          ...(states.length ? { states } : {}),
        }), counts: service.store.stateCounts(projectId) });
      }
      if (req.method === 'POST' && path === '/tasks') {
        const key = z.string().min(1).max(200).parse(req.headers['idempotency-key']);
        return send(res, 201, service.submit(await body(req), key));
      }
      const match = /^\/tasks\/([a-f0-9-]{36})(?:\/(events|evidence|items|diff|run|mode|plan|approve|cancel|cleanup)(?:\/(\d{1,12}))?)?$/.exec(path);
      if (match) {
        const id = match[1]!; const action = match[2]; const sub = match[3];
        if (req.method === 'GET' && action === 'diff' && !sub) {
          if (url.search) throw new AppError('invalid_diff_request', 'Diff requests accept a task ID only; no paths, refs or options');
          return send(res, 200, await service.diff(id));
        }
        if (req.method === 'GET' && !action) return send(res, 200, { ...service.store.task(id), approval: service.store.planApproval(id) });
        if (req.method === 'GET' && action === 'events') return send(res, 200, service.store.events(id, integer(url.searchParams.get('after'), 0), Math.min(integer(url.searchParams.get('limit'), 500), 1000)));
        if (req.method === 'GET' && action === 'evidence' && sub) return send(res, 200, boundEvidence(service.store.evidenceEntry(id, Number(sub)), EVIDENCE_ENTRY_BYTES));
        if (req.method === 'GET' && action === 'evidence') return send(res, 200, service.store.evidence(id, integer(url.searchParams.get('after'), 0), Math.min(integer(url.searchParams.get('limit'), 200), 1000)).map(e => boundEvidence(e, EVIDENCE_PREVIEW_BYTES)));
        if (req.method === 'GET' && action === 'items') return send(res, 200, service.store.workItems(id));
        if (req.method === 'POST' && !sub) {
          if (action === 'run') return send(res, 202, service.run(id));
          if (action === 'mode') return send(res, 200, service.mode(id, z.strictObject({ mode: z.unknown() }).parse(await body(req)).mode));
          if (action === 'plan') return send(res, 200, await service.proposePlan(id, await body(req)));
          if (action === 'approve') return send(res, 200, service.approve(id, z.strictObject({ version: z.number().int().nonnegative() }).parse(await body(req)).version));
          if (action === 'cancel') return send(res, 200, service.cancel(id));
          if (action === 'cleanup') return send(res, 200, await service.cleanup(id));
        }
      }
      throw new AppError('not_found', 'Unknown endpoint', 404);
    } catch (error) {
      if (error instanceof ZodError) return send(res, 400, { error: 'validation_error', message: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
      if (error instanceof AppError) return send(res, error.status, { error: error.code, message: error.message });
      log('request_failed', { message: error instanceof Error ? error.message : String(error) });
      send(res, 500, { error: 'internal_error', message: 'Request failed; inspect the service log' });
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  return server;
}
