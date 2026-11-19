import { createHmac } from 'node:crypto';
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { isAbsolute, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { z, ZodError } from 'zod';
import { AppError } from '../domain/errors.js';
import { createBrowserAccess, type BrowserAccessOptions } from './browser-access.js';
import { securityHeaders } from './static.js';

const uuid = z.uuid();
export function workspaceSocket(directory: string, userId: string) {
  if (!isAbsolute(directory) || !uuid.safeParse(userId).success) throw new AppError('invalid_workspace', 'Expected an absolute socket directory and an internal user ID');
  return join(directory, userId, 'api.sock');
}

/** This listener is accessible only through the owner runtime's private socket mount. */
export function runtimeAccess(req: IncomingMessage, ownerId: string) {
  const attempt = req.headers['x-devagents-setup-session'];
  if (req.socket.remoteAddress || req.headers['x-devagents-owner'] !== ownerId || typeof attempt !== 'string' || !/^[0-9a-f]{64}$/.test(attempt)) {
    throw new AppError('workspace_forbidden', 'Workspace identity mismatch', 403);
  }
  return { actor: { kind: 'user' as const, userId: ownerId }, setupOwner: attempt };
}

export function createWorkspaceGateway(token: string, options: BrowserAccessOptions, directory: string) {
  if (!options.sharedLogin || !isAbsolute(directory)) throw new AppError('invalid_config', 'The gateway requires shared login and an absolute workspace socket directory');
  const send = (res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { ...securityHeaders, 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(data));
  };
  const delegate = (userId: string, session: string) => ({
    socketPath: workspaceSocket(directory, userId),
    headers: {
      'x-devagents-owner': userId,
      // The worker can correlate a setup attempt without receiving a reusable browser session.
      'x-devagents-setup-session': createHmac('sha256', token).update(userId).update(':').update(session).digest('hex'),
    },
  });
  const access = createBrowserAccess(token, options, send, async (session, user) => {
    const stop = request({ ...delegate(user.id, session), method: 'POST', path: '/internal/session-ended', signal: AbortSignal.timeout(3000) });
    await new Promise<void>(resolve => {
      stop.once('response', response => { response.resume(); response.once('end', resolve); response.once('close', resolve); });
      stop.once('error', () => resolve());
      stop.end();
    });
  });
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { status: 'ok', mode: 'gateway' });
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(302, { ...securityHeaders, location: '/ui/' }); res.end(); return;
      }
      const verified = await access(req, res, url);
      if (!verified) return;
      if (verified.actor.kind !== 'user') throw new AppError('session_required', 'Sign in to select a personal workspace', 403);
      if (url.pathname.startsWith('/internal/') || url.pathname.startsWith('/ui/')) throw new AppError('not_found', 'Unknown endpoint', 404);
      // Never accept an upstream address, identity, Cookie or bearer token from the client.
      const target = delegate(verified.actor.userId, verified.setupOwner);
      const headers: Record<string, string> = { ...target.headers };
      for (const name of ['content-type', 'idempotency-key']) {
        const value = req.headers[name];
        if (typeof value === 'string') headers[name] = value;
      }
      const upstream = request({ socketPath: target.socketPath, method: req.method, path: url.pathname + url.search, headers, signal: AbortSignal.timeout(120000) });
      const abort = () => upstream.destroy();
      res.once('close', abort);
      try {
        const response = await new Promise<IncomingMessage>((resolve, reject) => {
          upstream.once('error', reject);
          upstream.once('response', resolve);
          req.pipe(upstream);
        });
        res.writeHead(response.statusCode ?? 502, { ...securityHeaders, 'cache-control': 'private, no-store', 'content-type': response.headers['content-type'] ?? 'application/json' });
        await pipeline(response, res);
      } finally {
        res.off('close', abort);
        upstream.destroy();
      }
    } catch (error) {
      if (res.headersSent || res.destroyed) { res.destroy(); return; }
      if (error instanceof AppError) return send(res, error.status, { error: error.code, message: error.message });
      if (error instanceof ZodError) return send(res, 400, { error: 'invalid_request', message: 'Invalid request' });
      send(res, 503, { error: 'workspace_unavailable', message: 'Your workspace is unavailable. Check that its runtime is running.' });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return server;
}
