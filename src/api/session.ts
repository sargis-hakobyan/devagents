import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * In-memory browser sessions for the local UI. A session is created only by exchanging a
 * single-use bootstrap code minted through the bearer-authenticated CLI, so the long-lived
 * CLI token never reaches the browser. Sessions end on restart, after 12 hours idle or
 * 24 hours in total, or on logout.
 */
export const CODE_TTL_MS = 10 * 60 * 1000;
export const IDLE_TTL_MS = 12 * 60 * 60 * 1000;
export const ABSOLUTE_TTL_MS = 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = 'devagents_session';

export type BrowserSession = { id: string; csrfToken: string; createdAt: number; lastSeenAt: number };

const token = () => randomBytes(32).toString('hex');
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class BrowserSessions {
  private readonly codes = new Map<string, number>();
  private readonly sessions = new Map<string, BrowserSession>();
  constructor(private readonly now: () => number = () => Date.now()) {}
  /** A one-time code; at most a handful may be outstanding so a forgotten link cannot pile up. */
  mintCode(): string {
    this.prune();
    if (this.codes.size >= 8) { const oldest = [...this.codes.entries()].sort((a, b) => a[1] - b[1])[0]!; this.codes.delete(oldest[0]); }
    const code = token(); this.codes.set(code, this.now() + CODE_TTL_MS); return code;
  }
  /** Consumes the code; a second use of the same code fails. */
  exchange(code: string): BrowserSession | undefined {
    this.prune();
    const match = [...this.codes.keys()].find(c => same(c, code));
    if (!match) return undefined;
    this.codes.delete(match);
    const session: BrowserSession = { id: token(), csrfToken: token(), createdAt: this.now(), lastSeenAt: this.now() };
    this.sessions.set(session.id, session);
    return session;
  }
  get(id: string | undefined): BrowserSession | undefined {
    if (!id) return undefined;
    this.prune();
    const session = [...this.sessions.values()].find(s => same(s.id, id));
    if (!session) return undefined;
    session.lastSeenAt = this.now();
    return session;
  }
  destroy(id: string): void { this.sessions.delete(id); }
  verifyCsrf(session: BrowserSession, supplied: string | undefined): boolean { return typeof supplied === 'string' && same(session.csrfToken, supplied); }
  expiresAt(session: BrowserSession): number { return Math.min(session.lastSeenAt + IDLE_TTL_MS, session.createdAt + ABSOLUTE_TTL_MS); }
  private prune(): void {
    const now = this.now();
    for (const [code, expires] of this.codes) if (expires <= now) this.codes.delete(code);
    for (const [id, s] of this.sessions) if (this.expiresAt(s) <= now) this.sessions.delete(id);
  }
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('='); if (index < 0) continue;
    cookies.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return cookies;
}
export function sessionCookie(id: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ABSOLUTE_TTL_MS / 1000)}${secure ? '; Secure' : ''}`;
}
export function clearedSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}
