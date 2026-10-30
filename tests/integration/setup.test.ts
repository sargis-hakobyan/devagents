import test from 'node:test';
import { request } from 'node:http';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { fixture } from '../helpers.js';
import { createApi } from '../../src/api/server.js';
import { SetupAuth } from '../../src/setup/auth.js';

test('browser setup uses session CSRF/Host/Origin, owns challenges, gates execution and cancels on logout', async () => {
  const f = await fixture(); let calls = 0;
  const setup = new SetupAuth({ status: async () => ({ saved: false }), login: async (_method, _key, signal, challenge) => {
    calls++; challenge({ url: 'https://auth.openai.com/codex/device', code: 'ABCD-12345' });
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('synthetic-secret'))));
  } });
  const server = createApi(f.service, 'setup-fixture-token', { setupAuth: setup });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = async () => {
    const bootstrap = await fetch(origin + '/ui/bootstrap', { method: 'POST', headers: { authorization: 'Bearer setup-fixture-token', 'content-type': 'application/json' }, body: '{"setup":true}' });
    const res = await fetch((await bootstrap.json()).url, { redirect: 'manual' }); assert.equal(res.headers.get('location'), '/ui/settings/setup');
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
    const session = await (await fetch(origin + '/ui/session', { headers: { cookie } })).json();
    return { cookie, 'content-type': 'application/json', 'x-csrf-token': session.csrfToken, origin };
  };
  try {
    assert.equal((await fetch(origin + '/setup/auth')).status, 401);
    const headers = await login(); const other = await login();
    const input = { attemptId: crypto.randomUUID(), method: 'chatgpt' };
    for (const extra of [{ 'x-csrf-token': '' }, { origin: 'https://evil.example' }]) {
      assert.equal((await fetch(origin + '/setup/auth', { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(input) })).status, 403);
    }
    const foreignHost = await new Promise<number>(resolve => {
      const req = request(origin + '/setup/auth', { method: 'POST', headers: { ...headers, host: 'evil.example' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.end(JSON.stringify(input));
    });
    assert.equal(foreignHost, 403);
    assert.equal(calls, 0);
    // Request admission must be checked after the final body byte, not only at headers.
    let finishUpload!: () => void;
    let uploaded!: () => void;
    const admitted = new Promise<void>(resolve => { uploaded = resolve; });
    server.once('request', () => uploaded());
    const slowTask = new Promise<number>(resolve => {
      const req = request(origin + '/tasks', { method: 'POST', headers: { ...headers, 'idempotency-key': 'slow-upload' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.write('{'); finishUpload = () => req.end('"projectId":"fixture","request":"arrived before login"}');
    });
    await admitted;
    for (let i = 0; i < 2; i++) assert.equal((await fetch(origin + '/setup/auth', { method: 'POST', headers, body: JSON.stringify(input) })).status, 202);
    assert.equal(calls, 1);
    finishUpload(); assert.equal(await slowTask, 409);
    assert.doesNotMatch(await (await fetch(origin + '/setup/auth', { headers: other })).text(), /ABCD/);
    assert.equal((await fetch(origin + '/setup/auth/cancel', { method: 'POST', headers: other, body: '{}' })).status, 404);
    assert.equal((await fetch(origin + '/tasks', { method: 'POST', headers, body: JSON.stringify({ projectId: 'fixture', request: 'blocked during login' }) })).status, 409);
    assert.equal((await fetch(origin + '/setup/maintenance', { method: 'POST', headers, body: '{}' })).status, 403);
    assert.equal((await fetch(origin + '/ui/logout', { method: 'POST', headers, body: '{}' })).status, 200);
    assert.equal(setup.busy, false);
    const reached = new Promise<void>(resolve => server.once('request', () => resolve()));
    const slowLogin = new Promise<number>(resolve => {
      const req = request(origin + '/setup/auth', { method: 'POST', headers: other }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.write('{'); finishUpload = () => req.end(`"attemptId":"${crypto.randomUUID()}","method":"chatgpt"}`);
    });
    await reached;
    assert.equal((await fetch(origin + '/setup/maintenance', { method: 'POST', headers: { authorization: 'Bearer setup-fixture-token' } })).status, 200);
    finishUpload(); assert.equal(await slowLogin, 409); assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(f.store.summaries()), /ABCD|synthetic-secret/);
  } finally { await setup.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.cleanup(); }
});
