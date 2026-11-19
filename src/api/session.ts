import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Local sessions use a single-use bootstrap code minted through the bearer-authenticated CLI;
 * shared sessions carry an identity verified by the configured login provider. The CLI token never
 * reaches the browser. On a local service a session lasts until sign-out: whoever can reach the browser can
 * reach the terminal and mint a link, so a timed sign-out protects nothing. Time limits remain
 * available for a deployment that is not local.
 */
export const CODE_TTL_MS = 10 * 60 * 1000;
export const SESSION_COOKIE = 'devagents_session';
/** Browsers cap a cookie's lifetime at about 400 days. */
const LONGEST_COOKIE_SECONDS = 400 * 24 * 60 * 60;
/** Sessions do not expire by themselves, so the oldest make room for new ones. */
export const MAX_SESSIONS = 20;

export type BrowserSession = { id: string; csrfToken: string; createdAt: number; lastSeenAt: number; userId?: string; providerId?: string };
/** Optional time limits; none by default. */
export type SessionLimits = { idleMs?: number; absoluteMs?: number };
/** Where sessions are kept so a service restart does not sign everyone out. */
export type SessionStorage = { load(): string | undefined; save(text: string): void };

const token = () => randomBytes(32).toString('hex');
const same = (a: string, b: string) => {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** `DEVAGENTS_SESSION_IDLE_HOURS` and `DEVAGENTS_SESSION_MAX_HOURS` restore timed sign-out; unset means no limit. */
export function sessionLimits(env: NodeJS.ProcessEnv = process.env, defaults: SessionLimits = {}): SessionLimits {
  const hours = (name: string) => { const value = Number(env[name]); return env[name] && Number.isFinite(value) && value > 0 ? value * 60 * 60 * 1000 : undefined; };
  const idleMs = hours('DEVAGENTS_SESSION_IDLE_HOURS'); const absoluteMs = hours('DEVAGENTS_SESSION_MAX_HOURS');
  return { ...defaults, ...(idleMs ? { idleMs } : {}), ...(absoluteMs ? { absoluteMs } : {}) };
}
/**
 * A private file in the data directory, beside the CLI token and protected the same way (0600 in a
 * 0700 directory). The CLI token there already grants more than a browser session does.
 */
export function sessionFile(dataDir: string, mode: 'local' | 'shared' = 'local'): SessionStorage {
  const path = join(dataDir, mode === 'local' ? 'browser-sessions.json' : 'shared-browser-sessions.json');
  return {
    load() { try { return readFileSync(path, 'utf8'); } catch { return undefined; } },
    save(text) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
      writeFileSync(temporary, text, { mode: 0o600 }); chmodSync(temporary, 0o600); renameSync(temporary, path);
    },
  };
}

export class BrowserSessions {
  private readonly codes = new Map<string, number>();
  private readonly sessions = new Map<string, BrowserSession>();
  private persistedAt = 0;
  constructor(private readonly now: () => number = () => Date.now(), private readonly limits: SessionLimits = {}, private readonly storage?: SessionStorage) {
    try {
      for (const saved of JSON.parse(storage?.load() ?? '[]') as Partial<BrowserSession>[]) {
        if (typeof saved?.id === 'string' && /^[a-f0-9]{64}$/.test(saved.id) && typeof saved.csrfToken === 'string' && /^[a-f0-9]{64}$/.test(saved.csrfToken) && typeof saved.createdAt === 'number') {
          if ((saved.userId !== undefined || saved.providerId !== undefined) && (typeof saved.userId !== 'string' || !saved.userId || typeof saved.providerId !== 'string' || !saved.providerId)) continue;
          this.sessions.set(saved.id, { id: saved.id, csrfToken: saved.csrfToken, createdAt: saved.createdAt,
            lastSeenAt: typeof saved.lastSeenAt === 'number' ? saved.lastSeenAt : saved.createdAt,
            ...(saved.userId && saved.providerId ? { userId: saved.userId, providerId: saved.providerId } : {}) });
        }
      }
    } catch { /* An unreadable file only means signing in again. */ }
  }
  /** Sign-in must keep working when the file cannot be written; the session then lasts until the next restart. */
  private persist(): void {
    try { this.storage?.save(JSON.stringify([...this.sessions.values()])); this.persistedAt = this.now(); }
    catch { /* kept in memory */ }
  }
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
    return this.create();
  }
  /** Called only after the selected login provider verifies an identity. */
  create(identity?: { userId: string; providerId: string }): BrowserSession {
    this.prune();
    const session: BrowserSession = { id: token(), csrfToken: token(), createdAt: this.now(), lastSeenAt: this.now(), ...identity };
    this.sessions.set(session.id, session);
    for (const old of [...this.sessions.values()].sort((a, b) => b.createdAt - a.createdAt).slice(MAX_SESSIONS)) this.sessions.delete(old.id);
    this.persist();
    return session;
  }
  get(id: string | undefined): BrowserSession | undefined {
    if (!id) return undefined;
    this.prune();
    const session = [...this.sessions.values()].find(s => same(s.id, id));
    if (!session) return undefined;
    session.lastSeenAt = this.now();
    if (this.limits.idleMs !== undefined && this.now() - this.persistedAt >= 60000) this.persist();
    return session;
  }
  destroy(id: string): void { if (this.sessions.delete(id)) this.persist(); }
  verifyCsrf(session: BrowserSession, supplied: string | undefined): boolean { return typeof supplied === 'string' && same(session.csrfToken, supplied); }
  /** When the session ends by itself; `undefined` when no limit is set. */
  expiresAt(session: BrowserSession): number | undefined {
    const ends = [this.limits.idleMs === undefined ? undefined : session.lastSeenAt + this.limits.idleMs, this.limits.absoluteMs === undefined ? undefined : session.createdAt + this.limits.absoluteMs].filter((v): v is number => v !== undefined);
    return ends.length ? Math.min(...ends) : undefined;
  }
  /** The cookie outlives the session only by the browser's own cap; the service decides validity. */
  get cookieMaxAgeSeconds(): number { return this.limits.absoluteMs === undefined ? LONGEST_COOKIE_SECONDS : Math.floor(this.limits.absoluteMs / 1000); }
  private prune(): void {
    const now = this.now(); let removed = false;
    for (const [code, expires] of this.codes) if (expires <= now) this.codes.delete(code);
    for (const [id, s] of this.sessions) { const end = this.expiresAt(s); if (end !== undefined && end <= now) { this.sessions.delete(id); removed = true; } }
    if (removed) this.persist();
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
export function sessionCookie(id: string, secure: boolean, maxAgeSeconds = LONGEST_COOKIE_SECONDS): string {
  return `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}
export function clearedSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}
