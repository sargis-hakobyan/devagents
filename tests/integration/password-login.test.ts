import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { request } from 'node:http';
import { LoginAccounts } from '../../src/persistence/login-accounts.js';
import { Store } from '../../src/persistence/store.js';
import { PasswordLogin } from '../../src/auth/password.js';
import { createApi } from '../../src/api/server.js';
import { BrowserSessions } from '../../src/api/session.js';
import { fixture } from '../helpers.js';

async function sharedFixture(https = false) {
  const f = await fixture();
  const accounts = new LoginAccounts(join(f.dataDir, 'test.db'));
  const provider = await PasswordLogin.create(accounts);
  let now = Date.now(); const sessions = new BrowserSessions(() => now, { idleMs: 3600000, absoluteMs: 43200000 });
  const sharedLogin = { provider, users: accounts, publicOrigin: https ? 'https://devagents.example.test' : 'http://127.0.0.1:4310' };
  const server = createApi(f.service, 'fixture-operator', { sessions, sharedLogin, workspaceOwnerId: accounts.passwordAccount('admin')!.user.id });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port; const base = sharedLogin.publicOrigin;
  const call = (path: string, method = 'GET', data?: unknown, headers: Record<string, string> = {}) => new Promise<{ status: number; cookie: string | undefined; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { host: new URL(sharedLogin.publicOrigin).host, ...(data === undefined ? {} : { 'content-type': 'application/json', origin: sharedLogin.publicOrigin }), ...headers } }, res => {
      let body = ''; res.on('data', c => { body += c; }); res.on('end', () => resolve({ status: res.statusCode!, cookie: res.headers['set-cookie']?.[0], body }));
    }); req.on('error', reject); req.end(data === undefined ? undefined : JSON.stringify(data));
  });
  return { ...f, accounts, sessions, call, base, tick: (ms: number) => { now += ms; }, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); accounts.close(); await f.cleanup(); } };
}
const credentials = { username: 'admin', password: 'admin' };

test('password login establishes a user-bound session, rotates it, preserves CSRF and signs out', async () => {
  const f = await sharedFixture();
  try {
    assert.deepEqual(JSON.parse((await f.call('/ui/auth')).body), { method: 'password' });
    assert.equal((await f.call('/tasks')).status, 401);
    const bad = await f.call('/ui/login', 'POST', { ...credentials, password: 'wrong' });
    const unknown = await f.call('/ui/login', 'POST', { ...credentials, username: 'unknown' });
    assert.equal(bad.status, 401); assert.equal(bad.body, unknown.body); assert.equal(bad.cookie, undefined);
    const login = await f.call('/ui/login', 'POST', credentials);
    assert.equal(login.status, 200); assert.match(login.cookie!, /HttpOnly; SameSite=Strict; Max-Age=43200/);
    const cookie = login.cookie!.split(';')[0]!;
    const identity = JSON.parse((await f.call('/ui/session', 'GET', undefined, { cookie })).body);
    assert.equal(identity.method, 'password'); assert.equal(identity.user.name, 'Administrator'); assert.match(identity.user.id, /^[a-f0-9-]{36}$/);
    assert.doesNotMatch(JSON.stringify(identity), /salt|hash|password_accounts/);
    assert.equal((await f.call('/tasks', 'GET', undefined, { cookie })).status, 200);
    assert.equal((await f.call('/tasks', 'POST', {}, { cookie })).status, 403);
    assert.equal((await f.call('/ui/logout', 'POST', {}, { cookie })).status, 403);
    const replacement = await f.call('/ui/login', 'POST', credentials, { cookie });
    assert.notEqual(replacement.cookie, login.cookie);
    assert.equal((await f.call('/tasks', 'GET', undefined, { cookie })).status, 401);
    const newCookie = replacement.cookie!.split(';')[0]!;
    const current = JSON.parse((await f.call('/ui/session', 'GET', undefined, { cookie: newCookie })).body);
    const logout = await f.call('/ui/logout', 'POST', {}, { cookie: newCookie, 'x-csrf-token': current.csrfToken });
    assert.equal(logout.status, 200); assert.match(logout.cookie!, /Max-Age=0/);
    assert.equal((await f.call('/tasks', 'GET', undefined, { cookie: newCookie })).status, 401);
  } finally { await f.close(); }
});

test('shared mode rejects foreign origins, forged identity headers, local sessions and bootstrap bypasses', async () => {
  const f = await sharedFixture();
  try {
    for (const headers of [{ origin: 'https://attacker.invalid' }, { origin: '' }, { host: 'attacker.invalid' }, { 'sec-fetch-site': 'cross-site' }, { origin: f.base.replace('http:', 'https:') }]) {
      assert.equal((await f.call('/ui/login', 'POST', credentials, headers)).status, 403);
    }
    assert.equal((await f.call('/tasks', 'GET', undefined, { 'x-oidc-email': 'admin@example.test', 'x-user-id': 'admin', 'x-forwarded-host': new URL(f.base).host })).status, 401);
    const link = await f.call('/ui/bootstrap', 'POST', {}, { authorization: 'Bearer fixture-operator', origin: '' });
    assert.equal(link.status, 200); assert.deepEqual(JSON.parse(link.body), { url: `${f.base}/ui/`, singleUse: false, expiresInSeconds: null });
    assert.equal(link.cookie, undefined, 'the launcher receives a public URL, never a password-login bypass');
    const local = f.sessions.exchange(f.sessions.mintCode())!;
    assert.equal((await f.call('/tasks', 'GET', undefined, { cookie: `devagents_session=${local.id}` })).status, 401);
    const code = f.sessions.mintCode();
    const exchange = await f.call(`/ui/login?code=${code}`); assert.equal(exchange.cookie, undefined);
    const otherProvider = f.sessions.create({ userId: f.accounts.passwordAccount('admin')!.user.id, providerId: 'sso' });
    assert.equal((await f.call('/tasks', 'GET', undefined, { cookie: `devagents_session=${otherProvider.id}` })).status, 401);
    const login = await f.call('/ui/login', 'POST', credentials); const cookie = login.cookie!.split(';')[0]!;
    assert.equal((await f.call('/tasks', 'GET', undefined, { cookie, origin: 'https://attacker.invalid' })).status, 403);
    f.tick(3600001); assert.equal((await f.call('/tasks', 'GET', undefined, { cookie })).status, 401);
  } finally { await f.close(); }
});

test('password login has a bounded attempt budget and HTTPS cookies', async () => {
  // The service's public origin is configured at startup, not inferred from forwarded headers.
  const f = await sharedFixture(true);
  try {
    const login = await f.call('/ui/login', 'POST', credentials);
    assert.match(login.cookie!, /; Secure$/);
    // Malformed attempts are bounded too, without allocating expensive password hashes.
    for (let i = 0; i < 9; i++) assert.equal((await f.call('/ui/login', 'POST', {})).status, 401);
    assert.equal((await f.call('/ui/login', 'POST', credentials)).status, 429);
  } finally { await f.close(); }
});

test('an authenticated second identity cannot read, change, or run work in the bound workspace', async () => {
  const f = await sharedFixture();
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Private task' }, 'owner-request');
    // Synthetic identity only. Production has no account creation or password reset endpoint.
    const owner = f.accounts.passwordAccount('admin')!;
    const other = f.accounts.bootstrapPasswordAccount('other', 'Another administrator', owner.salt, owner.hash);
    const login = await f.call('/ui/login', 'POST', { username: 'other', password: 'admin' });
    assert.equal(login.status, 200);
    const cookie = login.cookie!.split(';')[0]!;
    const info = JSON.parse((await f.call('/ui/session', 'GET', undefined, { cookie })).body);
    assert.equal(info.user.id, other.id);
    const headers = { cookie, 'x-csrf-token': info.csrfToken };
    for (const path of ['/overview', '/teams', '/projects', '/status', '/tasks', '/setup/claude-auth', '/projects/fixture/integrations',
      `/tasks/${task.id}`, `/tasks/${task.id}/diff`, `/tasks/${task.id}/evidence`]) {
      assert.equal((await f.call(path, 'GET', undefined, headers)).status, 403, path);
    }
    for (const path of ['/tasks', '/setup/auth', `/tasks/${task.id}/approve`, `/tasks/${task.id}/cancel`]) {
      assert.equal((await f.call(path, 'POST', {}, headers)).status, 403, path);
    }
    assert.equal(f.store.task(task.id).version, task.version);
    assert.throws(() => f.service.workspaceFor({ ownerId: other.id }), /already assigned/);
    assert.throws(() => f.service.workspaceFor({ ownerId: undefined }), /explicit owner/);
  } finally { await f.close(); }
});

test('queued work uses the persisted workspace owner after restart and rejects a claim for another owner', async () => {
  const f = await sharedFixture();
  try {
    const id = f.accounts.passwordAccount('admin')!.user.id;
    const task = f.service.submit({ projectId: 'fixture', request: 'Queued before restart', mode: 'autonomous' }, 'owned-claim');
    const reopened = new Store(join(f.dataDir, 'test.db'));
    try {
      assert.equal(reopened.workspaceOwnerId(), id);
      const claim = reopened.claimDispatch('worker')!;
      assert.equal(claim.workspaceOwnerId, id);
      const wrong = { ...claim, workspaceOwnerId: 'other' };
      assert.throws(() => reopened.withDispatch(wrong, () => reopened.record(task.id, 'unexpected', {})), /another workspace/);
      assert.throws(() => reopened.heartbeatDispatch(wrong), /another workspace/);
      assert.throws(() => reopened.finishDispatch(wrong), /another workspace/);
      reopened.withDispatch(claim, () => reopened.record(task.id, 'owned', {}));
      reopened.finishDispatch(claim);
    } finally { reopened.close(); }
  } finally { await f.close(); }
});
