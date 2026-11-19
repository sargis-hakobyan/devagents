import type { IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { AppError } from '../domain/errors.js';
import { LOCAL_USER, type LoginProvider } from '../auth/types.js';
import { BrowserSessions, SESSION_COOKIE, parseCookies, type BrowserSession } from './session.js';
import type { UserDirectory, UserIdentity } from '../domain/identity.js';

export type Principal = { kind: 'bearer' } | { kind: 'session'; session: BrowserSession; user: UserIdentity };
export type SharedLogin = { provider: LoginProvider; users: UserDirectory; publicOrigin: string };
export type AuthenticationOptions = {
  sessions?: BrowserSessions;
  sharedLogin?: SharedLogin;
  publicPort?: number | undefined;
  allowedHosts?: (port: number) => string[];
};

/** HTTP/session policy; login providers never see requests, cookies, task services or engine credentials. */
export class ApiAuthentication {
  readonly sessions: BrowserSessions;
  private attempts: number[] = [];
  private inFlight = 0;
  constructor(private readonly token: string, private readonly options: AuthenticationOptions = {}, private readonly now = Date.now) {
    this.sessions = options.sessions ?? new BrowserSessions(undefined, options.sharedLogin ? { idleMs: 3600000, absoluteMs: 43200000 } : {});
  }
  get shared() { return this.options.sharedLogin; }
  publicPort(req: IncomingMessage) { return this.options.publicPort ?? req.socket.localPort ?? 0; }
  get loginMessage() { return this.shared ? 'Sign in with your username and password' : 'Sign in to the browser UI with the link from: devagents ui'; }

  assertBrowser(req: IncomingMessage, requireOrigin = false): void {
    const host = (req.headers.host ?? '').toLowerCase();
    const origin = this.shared?.publicOrigin;
    const allowed = origin ? [new URL(origin).host] : (this.options.allowedHosts ?? (p => ['127.0.0.1', 'localhost', '[::1]'].map(h => `${h}:${p}`)))(this.publicPort(req));
    if (!allowed.includes(host)) throw new AppError('forbidden_host', 'Browser requests need the configured public host and port', 403);
    if ((requireOrigin && !req.headers.origin) || (req.headers.origin !== undefined && (origin ? req.headers.origin !== origin : ![`http://${host}`, `https://${host}`].includes(req.headers.origin)))) {
      throw new AppError('forbidden_origin', 'Cross-origin browser requests are not allowed', 403);
    }
    const site = req.headers['sec-fetch-site'];
    if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') throw new AppError('forbidden_origin', 'Cross-site browser requests are not allowed', 403);
  }

  async authenticate(req: IncomingMessage): Promise<Principal> {
    if (req.headers.authorization !== undefined) {
      if (req.headers.origin) throw new AppError('forbidden_origin', 'Browser requests are not enabled on the bearer path', 403);
      const supplied = Buffer.from(req.headers.authorization); const expected = Buffer.from(`Bearer ${this.token}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new AppError('unauthorized', 'Use the local CLI or a valid bearer token', 401);
      // The server-owned CLI token remains an operator credential. It cannot mint shared login sessions.
      return { kind: 'bearer' };
    }
    const cookie = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
    if (!cookie) throw new AppError('unauthorized', this.loginMessage, 401);
    this.assertBrowser(req);
    const session = this.sessions.get(cookie);
    let user: UserIdentity | undefined;
    if (session && this.shared) {
      if (session.providerId === this.shared.provider.id && session.userId) {
        user = await this.shared.users.loginUser(session.userId);
      }
    } else if (session && !session.providerId && !session.userId) {
      user = LOCAL_USER;
    }
    if (!session || !user) throw new AppError('session_expired', this.shared ? `Your browser session has ended. ${this.loginMessage}.` : 'Your browser session has ended; create a new link with: devagents ui', 401);
    if (!['GET', 'HEAD'].includes(req.method ?? '') && !this.sessions.verifyCsrf(session, req.headers['x-csrf-token'] as string | undefined)) throw new AppError('csrf_required', 'State-changing requests need the session CSRF token', 403);
    return { kind: 'session', session, user };
  }

  async login(req: IncomingMessage, readInput: () => Promise<unknown>): Promise<BrowserSession> {
    if (!this.shared) throw new AppError('login_unavailable', 'Password login is not enabled in local mode', 404);
    this.assertBrowser(req, true);
    // Bounded, process-wide admission for this single-admin foundation; forwarded headers are untrusted.
    this.attempts = this.attempts.filter(at => at > this.now() - 60000);
    if (this.attempts.length >= 10 || this.inFlight >= 2) throw new AppError('login_throttled', 'Too many sign-in attempts. Try again in a minute.', 429);
    this.attempts.push(this.now()); this.inFlight++;
    try {
      const user = await this.shared.provider.authenticate(await readInput());
      if (!user) throw new AppError('invalid_credentials', 'Username or password is incorrect', 401);
      const previous = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
      if (previous) this.sessions.destroy(previous);
      return this.sessions.create({ userId: user.id, providerId: this.shared.provider.id });
    } finally { this.inFlight--; }
  }
}
