import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { Actor, UserIdentity } from '../domain/identity.js';
import { AppError } from '../domain/errors.js';
import { ApiAuthentication, type AuthenticationOptions } from './authentication.js';
import { sessionCookie, clearedSessionCookie } from './session.js';
import { securityHeaders, serveUi } from './static.js';
import { body } from './http-body.js';

export type BrowserAccessOptions = AuthenticationOptions & {
  uiRoot?: string | undefined;
  secureCookies?: boolean;
};
type Send = (res: ServerResponse, code: number, data: unknown, extra?: Record<string, string>) => void;

export function createBrowserAccess(token: string, options: BrowserAccessOptions, send: Send, onLogout: (sessionId: string, user: UserIdentity) => Promise<void>) {
  const auth = new ApiAuthentication(token, options);
  const sessions = auth.sessions;
  const secureCookies = auth.shared ? new URL(auth.shared.publicOrigin).protocol === 'https:' : Boolean(options.secureCookies);
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<{ actor: Actor; setupOwner: string } | void> => {
    const path = url.pathname;
    if (req.method === 'GET' && path === '/ui/auth') return send(res, 200, { method: auth.shared?.provider.id ?? 'local' });
    if (req.method === 'POST' && path === '/ui/login') {
      const session = await auth.login(req, () => body(req, 8192));
      return send(res, 200, { authenticated: true }, { 'set-cookie': sessionCookie(session.id, secureCookies, sessions.cookieMaxAgeSeconds) });
    }
    if (req.method === 'GET' && path === '/ui/login') {
      if (auth.shared) return serveUi(options.uiRoot, path, res);
      const session = sessions.exchange(url.searchParams.get('code') ?? '');
      if (!session) throw new AppError('invalid_login_code', 'This sign-in link is invalid, expired or already used; create a new one with: devagents ui', 403);
      res.writeHead(303, { ...securityHeaders, 'set-cookie': sessionCookie(session.id, secureCookies, sessions.cookieMaxAgeSeconds), location: url.searchParams.get('next') === 'setup' ? '/ui/settings/setup' : '/ui/', 'cache-control': 'no-store' });
      res.end();
      return;
    }
    if (req.method === 'GET' && (path === '/ui' || (path.startsWith('/ui/') && !['/ui/session', '/ui/logout', '/ui/bootstrap'].includes(path)))) return serveUi(options.uiRoot, path, res);
    const principal = await auth.authenticate(req);
    const viewer = req.headers['x-devagents-viewer'];
    if (principal.kind === 'session' && viewer !== undefined && viewer !== principal.user.id) {
      throw new AppError('session_changed', 'The signed-in account has changed. Reload the workspace.', 401);
    }
    if (path === '/ui/bootstrap' && req.method === 'POST') {
      if (principal.kind !== 'bearer') throw new AppError('bearer_required', 'Sign-in links are created through the CLI', 403);
      const input = z.object({ setup: z.boolean().optional() }).strict().parse(await body(req));
      if (auth.shared) return send(res, 200, { url: `${auth.shared.publicOrigin}/ui/`, singleUse: false, expiresInSeconds: null });
      return send(res, 201, { url: `http://127.0.0.1:${auth.publicPort(req)}/ui/login?code=${sessions.mintCode()}${input.setup ? '&next=setup' : ''}`, expiresInSeconds: 600, singleUse: true });
    }
    if (path === '/ui/session' && req.method === 'GET') {
      if (principal.kind !== 'session') throw new AppError('session_required', 'Only browser sessions have a CSRF token', 403);
      const expires = sessions.expiresAt(principal.session);
      return send(res, 200, { authenticated: true, csrfToken: principal.session.csrfToken, expiresAt: expires === undefined ? null : new Date(expires).toISOString(), user: principal.user, method: auth.shared?.provider.id ?? 'local' });
    }
    if (path === '/ui/logout' && req.method === 'POST') {
      if (principal.kind !== 'session') throw new AppError('session_required', 'Only browser sessions can sign out', 403);
      await onLogout(principal.session.id, principal.user);
      sessions.destroy(principal.session.id);
      return send(res, 200, { signedOut: true }, { 'set-cookie': clearedSessionCookie(secureCookies) });
    }
    if (principal.kind === 'bearer') return { actor: { kind: 'operator' }, setupOwner: 'terminal' };
    return { actor: { kind: 'user', userId: principal.user.id }, setupOwner: principal.session.id };
  };
}
