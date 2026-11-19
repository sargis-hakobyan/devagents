import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, scryptSync } from 'node:crypto';
import { mkdtemp, mkdir, rm, readFile, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fixture } from '../helpers.js';
import { FakeEngine, FixtureValidator } from '../fixtures/fake-engine.js';
import type { EngineRequest } from '../../src/domain/engine.js';
import { TaskRunner } from '../../src/orchestration/runner.js';
import { createApi } from '../../src/api/server.js';
import { createWorkspaceGateway } from '../../src/api/workspace-gateway.js';
import { listenPrivate } from '../../src/api/private-listener.js';
import { LoginAccounts } from '../../src/persistence/login-accounts.js';
import { PasswordLogin } from '../../src/auth/password.js';
import { SetupAuth, assertSignInIdle } from '../../src/setup/auth.js';
import { CredentialVault } from '../../src/security/credential-vault.js';

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

test('one gateway serves two private workspaces with overlapping runs and independent provider connections', { timeout: 60000 }, async () => {
  // Short path for the OS socket length limit. All logins, credentials, repos and engines are synthetic.
  const root = await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'da-ws-'));
  const accounts = await LoginAccounts.open(join(root, 'accounts.db'));
  const password = await PasswordLogin.create(accounts);
  const alice = (await accounts.passwordAccount('admin'))!.user;
  const salt = randomBytes(16).toString('hex');
  const bob = await accounts.bootstrapPasswordAccount('bob', 'Bob', salt, scryptSync('fixture-bob', salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }).toString('hex'));
  const releases: (() => Promise<void>)[] = [];
  const arrived = new Set<string>();
  let bothArrived!: () => void;
  const bothRunning = new Promise<void>(resolve => { bothArrived = resolve; });
  let releaseWorkers!: () => void;
  const proceed = new Promise<void>(resolve => { releaseWorkers = resolve; });
  const sharedLogin = { provider: password, users: accounts, publicOrigin: 'http://127.0.0.1' };
  const gateway = createWorkspaceGateway('fixture-operator', { sharedLogin }, root);
  try {
    async function startWorkspace(userId: string) {
      const f = await fixture();
      const runtime = join(f.root, 'private-runtime');
      const vault = new CredentialVault(f.dataDir, runtime, 'claude');
      await vault.unlock(randomBytes(32).toString('hex'));
      let saved = false;
      const setup = new SetupAuth({
        status: async () => saved ? { saved: true, method: 'subscription' } : { saved: false },
        login: async (_method, value) => {
          await mkdir(join(runtime, 'claude'), { recursive: true });
          await writeFile(vault.auth, JSON.stringify({ value }), { mode: 0o600 });
          await vault.seal(); saved = true;
        },
      }, async () => await assertSignInIdle(f.store, runner));
      const used: string[] = [];
      const engine = new class extends FakeEngine {
        override async execute(req: EngineRequest) {
          if (req.phase === 'implementation') {
            arrived.add(userId);
            if (arrived.size === 2) bothArrived();
            await Promise.race([proceed, new Promise<void>((_, reject) => req.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }))]);
            assert.ok(req.cwd.includes(f.root.split('/').at(-1)! + '/'));
            used.push(JSON.parse(await readFile(vault.auth, 'utf8')).value);
          }
          return super.execute(req);
        }
      }();
      const runner = new TaskRunner(f.service, engine, new FixtureValidator());
      f.service.attachRunner(runner);
      const server = await createApi(f.service, 'unused', { privateRuntimeOwner: userId, claudeAuth: setup });
      await listenPrivate(server, join(root, userId));
      releases.push(async () => { await close(server); await setup.close(); await runner.stop(); await f.cleanup(); });
      return { f, used, runner, vault };
    }
    const a = await startWorkspace(alice.id), b = await startWorkspace(bob.id);
    await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
    sharedLogin.publicOrigin = 'http://127.0.0.1:' + (gateway.address() as AddressInfo).port;
    const origin = sharedLogin.publicOrigin;
    async function client(username: string, value: string) {
      const login = await fetch(origin + '/ui/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username, password: value }) });
      assert.equal(login.status, 200);
      const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
      const session = await (await fetch(origin + '/ui/session', { headers: { cookie } })).json();
      return (path: string, data?: unknown, extra: Record<string, string> = {}) => fetch(origin + path, {
        method: data === undefined ? 'GET' : 'POST',
        headers: { cookie, origin, 'content-type': 'application/json', 'x-csrf-token': session.csrfToken, ...extra },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
    }
    const A = await client('admin', 'admin'), B = await client('bob', 'fixture-bob');
    // A missing or mis-mounted socket cannot fall through to a different owner's workspace.
    const third = await accounts.bootstrapPasswordAccount('third', 'Another user', salt, (await accounts.passwordAccount('bob'))!.hash);
    const C = await client('third', 'fixture-bob');
    assert.equal((await C('/projects')).status, 503);
    await symlink(join(root, alice.id), join(root, third.id), 'dir');
    assert.equal((await C('/projects')).status, 403);
    const connect = async (call: typeof A, value: string) => {
      const response = await call('/setup/claude-auth', { attemptId: randomUUID(), method: 'subscription', apiKey: value });
      assert.equal(response.status, 202);
      for (let i = 0; i < 50; i++) {
        const state = await (await call('/setup/claude-auth')).json();
        if (!state.busy) { assert.equal(state.job.state, 'completed'); return; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.fail('fixture credential setup stayed busy');
    };
    const team = await (await A('/teams', { name: 'Alice only', members: [] })).json();
    assert.equal(team.name, 'Alice only');
    assert.equal((await B('/teams/' + team.id)).status, 404);
    assert.deepEqual(await (await B('/teams')).json(), []);
    assert.equal((await A('/projects', undefined, { 'x-devagents-viewer': bob.id })).status, 401);
    await connect(A, 'fixture-a');
    await connect(B, 'fixture-b-old');
    await connect(B, 'fixture-b');
    const submit = async (call: typeof A, name: string) => {
      const res = await call('/tasks', { projectId: 'fixture', request: name, mode: 'autonomous' }, { 'idempotency-key': 'same-retry-key' });
      assert.equal(res.status, 201); return (await res.json()).id;
    };
    const [first, second] = await Promise.all([submit(A, 'Private A'), submit(B, 'Private B')]);
    assert.notEqual(first, second);
    await Promise.race([bothRunning, new Promise((_, reject) => { setTimeout(() => reject(new Error('Runs did not overlap')), 25000).unref(); })]);
    releaseWorkers();
    await Promise.all([a.runner.idle(), b.runner.idle()]);
    for (const [call, own, other, expected, workspace] of [[A, first, second, 'fixture-a', a], [B, second, first, 'fixture-b', b]] as const) {
      assert.deepEqual(workspace.used, [expected]);
      assert.equal((await (await call('/tasks/' + own)).json()).state, 'completed');
      assert.deepEqual((await (await call('/tasks')).json()).tasks.map((t: { id: string }) => t.id), [own]);
      for (const suffix of ['', '/events', '/diff', '/evidence', '/usage']) {
        assert.equal((await call('/tasks/' + other + suffix, undefined, { 'x-devagents-owner': call === A ? bob.id : alice.id })).status, 404);
      }
      assert.equal((await call('/tasks/' + other + '/cancel', {})).status, 404);
      assert.equal((await call('/setup/maintenance', {})).status, 403);
      assert.ok(!(await readFile(workspace.vault.encrypted, 'utf8')).includes(expected));
    }
    assert.equal((await A('/tasks', {}, { 'x-csrf-token': 'wrong' })).status, 403);
    assert.equal((await A('/internal/session-ended', {})).status, 404);
    assert.equal((await A('/ui/logout', {})).status, 200);
    assert.equal((await A('/projects')).status, 401);
    assert.equal((await B('/tasks/' + second)).status, 200);
  } finally {
    releaseWorkers();
    await close(gateway);
    for (const release of releases.reverse()) await release();
    await accounts.close();
    await rm(root, { recursive: true, force: true });
  }
});
