import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';
import { createApi } from '../../src/api/server.js';
import { BrowserSessions, CODE_TTL_MS, IDLE_TTL_MS } from '../../src/api/session.js';
import { fixture } from '../helpers.js';

async function uiFixture() {
  const f = await fixture();
  const uiRoot = join(f.root, 'ui'); await mkdir(join(uiRoot, 'assets'), { recursive: true });
  await writeFile(join(uiRoot, 'index.html'), '<!doctype html><html><head><title>DevAgents</title></head><body><div id="app"></div><script type="module" src="/ui/assets/app.js"></script></body></html>');
  await writeFile(join(uiRoot, 'assets', 'app.js'), 'console.log("ui")');
  await writeFile(join(f.root, 'secret.txt'), 'outside');
  let now = Date.parse('2026-10-30T10:00:00Z'); const sessions = new BrowserSessions(() => now);
  const server = createApi(f.service, 'cli-token', { sessions, uiRoot, status: async () => ({ ok: true }) });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port; const url = `http://127.0.0.1:${port}`;
  const bearer = { authorization: 'Bearer cli-token' };
  const cookieFor = async () => {
    const link = await (await fetch(`${url}/ui/bootstrap`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: '{}' })).json() as { url: string };
    const login = await fetch(link.url, { redirect: 'manual' });
    assert.equal(login.status, 303); assert.equal(login.headers.get('location'), '/ui/');
    const setCookie = login.headers.get('set-cookie')!;
    assert.match(setCookie, /^devagents_session=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=86400$/);
    return { cookie: setCookie.split(';')[0]!, code: new URL(link.url).searchParams.get('code')! };
  };
  return { ...f, url, port, server, sessions, bearer, cookieFor, tick: (ms: number) => { now += ms; }, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.cleanup(); } };
}

test('the UI shell and assets are public, carry a strict CSP, and never escape the bundle directory', async () => {
  const f = await uiFixture();
  try {
    const root = await fetch(`${f.url}/`, { redirect: 'manual' }); assert.equal(root.status, 302); assert.equal(root.headers.get('location'), '/ui/');
    for (const path of ['/ui/', '/ui', '/ui/tasks/0f69f6c0-674e-40ad-a45c-f33bda55e900', '/ui/settings']) {
      const page = await fetch(`${f.url}${path}`); assert.equal(page.status, 200, path);
      assert.match(page.headers.get('content-type')!, /text\/html/); assert.equal(page.headers.get('cache-control'), 'no-store');
      assert.match(page.headers.get('content-security-policy')!, /default-src 'self'; script-src 'self'; style-src 'self'/);
      assert.equal(page.headers.get('x-frame-options'), 'DENY'); assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
      assert.match(await page.text(), /<div id="app">/);
    }
    const asset = await fetch(`${f.url}/ui/assets/app.js`); assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type')!, /javascript/); assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    for (const path of ['/ui/assets/%2e%2e/%2e%2e/secret.txt', '/ui/assets/..%2f..%2fsecret.txt', '/ui/assets/missing.js', '/ui/assets/%00index.html']) {
      const escape = await fetch(`${f.url}${path}`);
      assert.ok([401, 404].includes(escape.status), `${path}: ${escape.status}`); assert.doesNotMatch(await escape.text(), /outside/, path);
    }
    const api = await fetch(`${f.url}/tasks`); assert.equal(api.status, 401);
    assert.equal(api.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"), true, 'API responses carry the security headers too');
    assert.equal(api.headers.get('set-cookie'), null, 'no cookie is ever set outside the login exchange');
  } finally { await f.close(); }
});
test('bootstrap links need the CLI token, are single use, expire, and establish an HttpOnly session', async () => {
  const f = await uiFixture();
  try {
    assert.equal((await fetch(`${f.url}/ui/bootstrap`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await fetch(`${f.url}/ui/bootstrap`, { method: 'POST', headers: { ...f.bearer, origin: 'http://127.0.0.1:9', 'content-type': 'application/json' }, body: '{}' })).status, 403, 'bearer path still refuses any Origin');
    const minted = await fetch(`${f.url}/ui/bootstrap`, { method: 'POST', headers: { ...f.bearer, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(minted.status, 201); const link = await minted.json() as { url: string; singleUse: boolean };
    assert.match(link.url, new RegExp(`^http://127\\.0\\.0\\.1:${f.port}/ui/login\\?code=[a-f0-9]{64}$`)); assert.equal(link.singleUse, true);
    assert.equal((await fetch(`${f.url}/ui/login?code=0000`, { redirect: 'manual' })).status, 403);
    const { cookie, code } = await f.cookieFor();
    assert.equal((await fetch(`${f.url}/ui/login?code=${code}`, { redirect: 'manual' })).status, 403, 'replaying a consumed code is rejected');
    const tasks = await fetch(`${f.url}/tasks`, { headers: { cookie } }); assert.equal(tasks.status, 200);
    const session = await (await fetch(`${f.url}/ui/session`, { headers: { cookie } })).json() as { authenticated: boolean; csrfToken: string; expiresAt: string };
    assert.equal(session.authenticated, true); assert.match(session.csrfToken, /^[a-f0-9]{64}$/);
    assert.equal(session.expiresAt, new Date(Date.parse('2026-10-30T10:00:00Z') + IDLE_TTL_MS).toISOString());
    assert.equal((await fetch(`${f.url}/ui/session`, { headers: f.bearer })).status, 403, 'the CLI token has no CSRF token or session');
    // An unused code expires.
    const stale = await (await fetch(`${f.url}/ui/bootstrap`, { method: 'POST', headers: { ...f.bearer, 'content-type': 'application/json' }, body: '{}' })).json() as { url: string };
    f.tick(CODE_TTL_MS + 1);
    assert.equal((await fetch(stale.url, { redirect: 'manual' })).status, 403);
    // An idle session expires.
    f.tick(IDLE_TTL_MS + 1);
    const expired = await fetch(`${f.url}/tasks`, { headers: { cookie } }); assert.equal(expired.status, 401);
    assert.equal(((await expired.json()) as { error: string }).error, 'session_expired');
  } finally { await f.close(); }
});
test('browser sessions are bound to the loopback host and same origin, and state changes need the CSRF token', async () => {
  const f = await uiFixture();
  try {
    const { cookie } = await f.cookieFor();
    // fetch() refuses to send a custom Host header, so the rebinding cases go through node:http.
    const raw = (headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: f.port, path: '/tasks', method: 'GET', headers: { cookie, ...headers } }, res => { res.resume(); resolve(res.statusCode ?? 0); });
      req.once('error', reject); req.end();
    });
    const ok = async (headers: Record<string, string>) => (await fetch(`${f.url}/tasks`, { headers: { cookie, ...headers } })).status;
    assert.equal(await ok({ origin: `http://127.0.0.1:${f.port}` }), 200);
    assert.equal(await ok({ 'sec-fetch-site': 'same-origin' }), 200);
    assert.equal(await raw({ host: `127.0.0.1:${f.port}` }), 200);
    assert.equal(await raw({ host: `localhost:${f.port}` }), 200);
    assert.equal(await raw({ host: `evil.example:${f.port}` }), 403, 'DNS rebinding: unknown Host');
    assert.equal(await raw({ host: `127.0.0.1:${f.port + 1}` }), 403, 'another local port');
    assert.equal(await raw({ host: '127.0.0.1' }), 403, 'host without the port');
    assert.equal(await ok({ origin: `http://localhost:${f.port + 1}` }), 403, 'another localhost origin');
    assert.equal(await ok({ origin: 'https://attacker.invalid' }), 403);
    assert.equal(await ok({ 'sec-fetch-site': 'cross-site' }), 403);
    assert.equal(await ok({ cookie: 'devagents_session=' + 'f'.repeat(64) }), 401, 'unknown session id');
    const session = await (await fetch(`${f.url}/ui/session`, { headers: { cookie } })).json() as { csrfToken: string };
    const csrf = (headers: Record<string, string>) => fetch(`${f.url}/ui/logout`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', ...headers }, body: '{}' });
    assert.equal((await csrf({})).status, 403, 'missing CSRF token');
    assert.equal((await csrf({ 'x-csrf-token': 'a'.repeat(64) })).status, 403, 'wrong CSRF token');
    assert.equal((await fetch(`${f.url}/tasks/0f69f6c0-674e-40ad-a45c-f33bda55e900/cancel`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' })).status, 403, 'every state-changing route needs the token');
    const out = await csrf({ 'x-csrf-token': session.csrfToken }); assert.equal(out.status, 200);
    assert.match(out.headers.get('set-cookie')!, /^devagents_session=; Path=\/; HttpOnly; SameSite=Strict; Max-Age=0$/);
    assert.equal(await ok({}), 401, 'the session is gone after logout');
    assert.equal((await fetch(`${f.url}/tasks`, { headers: f.bearer })).status, 200, 'the CLI bearer path is unaffected');
    assert.equal((await fetch(`${f.url}/status`, { headers: f.bearer })).status, 200);
  } finally { await f.close(); }
});

test('a published public port replaces the listening port in the Host allowlist and in sign-in links', async () => {
  const f = await fixture(); const sessions = new BrowserSessions();
  const server = createApi(f.service, 'cli-token', { sessions, publicPort: 4310 });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const link = await (await fetch(`http://127.0.0.1:${port}/ui/bootstrap`, { method: 'POST', headers: { authorization: 'Bearer cli-token', 'content-type': 'application/json' }, body: '{}' })).json() as { url: string };
    assert.match(link.url, /^http:\/\/127\.0\.0\.1:4310\/ui\/login\?code=/);
    const login = await fetch(`http://127.0.0.1:${port}/ui/login?code=${new URL(link.url).searchParams.get('code')}`, { redirect: 'manual' });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const raw = (host: string) => new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/tasks', method: 'GET', headers: { cookie, host } }, res => { res.resume(); resolve(res.statusCode ?? 0); });
      req.once('error', reject); req.end();
    });
    assert.equal(await raw('127.0.0.1:4310'), 200, 'the published port is accepted');
    assert.equal(await raw('localhost:4310'), 200);
    assert.equal(await raw(`127.0.0.1:${port}`), 403, 'the internal listening port is not what the browser uses');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.cleanup(); }
});
