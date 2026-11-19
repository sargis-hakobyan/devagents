import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserSessions, MAX_SESSIONS, sessionCookie, sessionFile, sessionLimits } from '../../src/api/session.js';

const HOUR = 60 * 60 * 1000;
const signIn = (sessions: BrowserSessions) => sessions.exchange(sessions.mintCode())!;

test('a session survives a service restart and ends only on sign-out', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devagents-sessions-')); let now = Date.parse('2026-11-13T15:00:00Z');
  try {
    const first = new BrowserSessions(() => now, {}, sessionFile(dir));
    const session = signIn(first); const other = signIn(first);
    assert.equal(first.expiresAt(session), undefined);
    assert.equal((await stat(join(dir, 'browser-sessions.json'))).mode & 0o777, 0o600, 'kept private, like the CLI token beside it');
    now += 25 * HOUR; // the laptop slept overnight
    assert.equal(first.get(session.id)?.csrfToken, session.csrfToken);

    // A restart: a new process reads the same file. The cookie and the CSRF token the browser holds still work.
    const second = new BrowserSessions(() => now, {}, sessionFile(dir));
    const restored = second.get(session.id);
    assert.equal(restored?.csrfToken, session.csrfToken); assert.equal(second.verifyCsrf(restored!, session.csrfToken), true);
    assert.equal(second.get('f'.repeat(64)), undefined, 'an unknown cookie is still refused');
    second.destroy(session.id);
    const third = new BrowserSessions(() => now, {}, sessionFile(dir));
    assert.equal(third.get(session.id), undefined, 'sign-out is remembered too'); assert.ok(third.get(other.id));

    // A damaged or foreign file means signing in again, never a crash or a forged session.
    await writeFile(join(dir, 'browser-sessions.json'), '[{"id":"short","csrfToken":"x","createdAt":1},{"id":"' + 'a'.repeat(64) + '"}]');
    assert.equal(new BrowserSessions(() => now, {}, sessionFile(dir)).get('a'.repeat(64)), undefined);
    await writeFile(join(dir, 'browser-sessions.json'), 'not json');
    assert.ok(signIn(new BrowserSessions(() => now, {}, sessionFile(dir))));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('sessions that never expire are bounded in number, oldest first', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devagents-sessions-')); let now = 1_000_000;
  try {
    const sessions = new BrowserSessions(() => now, {}, sessionFile(dir));
    const all = Array.from({ length: MAX_SESSIONS + 3 }, () => { now += 1000; return signIn(sessions); });
    assert.equal(sessions.get(all[0]!.id), undefined); assert.equal(sessions.get(all[2]!.id), undefined);
    assert.ok(sessions.get(all[3]!.id)); assert.ok(sessions.get(all.at(-1)!.id));
    assert.equal((JSON.parse(await readFile(join(dir, 'browser-sessions.json'), 'utf8')) as unknown[]).length, MAX_SESSIONS);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('time limits still work where they are configured', () => {
  assert.deepEqual(sessionLimits({}), {});
  assert.deepEqual(sessionLimits({ DEVAGENTS_SESSION_IDLE_HOURS: '12', DEVAGENTS_SESSION_MAX_HOURS: '24' }), { idleMs: 12 * HOUR, absoluteMs: 24 * HOUR });
  assert.deepEqual(sessionLimits({ DEVAGENTS_SESSION_IDLE_HOURS: '0', DEVAGENTS_SESSION_MAX_HOURS: 'soon' }), {}, 'an invalid value means no limit, not a broken sign-in');
  let now = Date.parse('2026-11-13T15:00:00Z');
  const sessions = new BrowserSessions(() => now, { idleMs: 12 * HOUR, absoluteMs: 24 * HOUR });
  const idle = signIn(sessions);
  assert.equal(sessions.expiresAt(idle), now + 12 * HOUR); assert.equal(sessions.cookieMaxAgeSeconds, 24 * 60 * 60);
  now += 12 * HOUR + 1; assert.equal(sessions.get(idle.id), undefined, 'idle limit');
  const busy = signIn(sessions);
  for (let i = 0; i < 3; i++) { now += 7 * HOUR; assert.ok(sessions.get(busy.id)); }
  now += 4 * HOUR; assert.equal(sessions.get(busy.id), undefined, 'total limit, however active');
  assert.match(sessionCookie('a'.repeat(64), false), /HttpOnly; SameSite=Strict; Max-Age=34560000$/);
  assert.match(sessionCookie('a'.repeat(64), true, 60), /Max-Age=60; Secure$/);
  assert.equal(sessions.get('é'.repeat(64)), undefined, 'non-ASCII cookie values are refused without a byte-length exception');
  assert.equal(sessions.verifyCsrf(busy, 'é'.repeat(64)), false);
});

test('shared identity and expiry survive restart without importing local sessions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devagents-shared-sessions-')); let now = Date.now();
  const limits = { idleMs: HOUR, absoluteMs: 12 * HOUR };
  try {
    const local = new BrowserSessions(() => now, {}, sessionFile(dir)); const localSession = signIn(local);
    const sessions = new BrowserSessions(() => now, limits, sessionFile(dir, 'shared'));
    assert.equal(sessions.get(localSession.id), undefined);
    const signedIn = sessions.create({ userId: 'admin-id', providerId: 'password' });
    now += 30 * 60 * 1000; assert.ok(sessions.get(signedIn.id));
    const restarted = new BrowserSessions(() => now, limits, sessionFile(dir, 'shared'));
    assert.equal(restarted.get(signedIn.id)?.userId, 'admin-id');
    assert.equal(restarted.get(signedIn.id)?.providerId, 'password');
    now += HOUR + 1;
    assert.equal(new BrowserSessions(() => now, limits, sessionFile(dir, 'shared')).get(signedIn.id), undefined, 'a restart cannot revive an idle session');
    assert.ok(new BrowserSessions(() => now, {}, sessionFile(dir)).get(localSession.id));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
