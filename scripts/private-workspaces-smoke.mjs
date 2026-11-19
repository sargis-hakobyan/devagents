// Exercise the production entry points with disposable volumes and synthetic credentials.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const probe = createServer();
await new Promise(r => probe.listen(0, '127.0.0.1', r));
const port = probe.address().port;
await new Promise(r => probe.close(r));
const origin = 'http://127.0.0.1:' + port;
const project = 'devagents-two-users-' + randomUUID().slice(0, 8);
const secretDir = mkdtempSync(join(tmpdir(), 'devagents-pg-smoke-'));
// The host directory is 0700. Docker mounts individual files for different container UIDs.
for (const name of ['postgres-admin', 'workspace-db', 'gateway-db']) {
  const file = join(secretDir, name);
  writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 });
  chmodSync(file, 0o444);
}
function compose(args, options = {}) {
  const result = spawnSync('docker', ['compose', '-f', 'examples/compose.workspaces.yaml', '-p', project, ...args], {
    env: { ...process.env, DEVAGENTS_PREVIEW_PORT: String(port), DEVAGENTS_DB_SECRETS_DIR: secretDir }, encoding: 'utf8', timeout: 300000, ...options,
  });
  // No captured output from secret-handling processes is printed, even on failure.
  if (result.status !== 0) throw new Error('Docker workspace smoke step failed: ' + args[0]);
  return result.stdout;
}

let browser;
try {
  compose(['build', 'gateway']);
  compose(['up', '-d', '--no-build', '--wait']);
  // Check isolation with a workspace login directly, independently of the HTTP authorization layer.
  compose(['exec', '-T', 'alice', 'node', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { PgSession } from './dist/persistence/pg-session.js';
    const db = await PgSession.open('/data/devagents.db');
    try {
      assert.equal((await db.prepare('SELECT current_schema() AS name').get()).name, 'public');
      assert.deepEqual(await db.prepare("SELECT DISTINCT table_schema FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')").all(), [{table_schema:'public'}]);
      await assert.rejects(() => db.prepare('SELECT 1 FROM public.password_accounts').get(), { code: '42501' });
      await assert.rejects(() => db.prepare('INSERT INTO trackers(id,data,workspace_id) VALUES ($1,$2,$3)').run('wrong','{}','22222222-2222-4222-8222-222222222222'), { code: '42501' });
    } finally { await db.close(); }`]);
  browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  const login = async name => {
    await page.goto(origin + '/ui/');
    await page.getByLabel('Username', { exact: true }).fill(name);
    await page.getByLabel('Password', { exact: true }).fill('demo-' + name);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('heading', { name: 'Workspace', exact: true }).waitFor();
    assert.match(await page.locator('.brand-ctx').innerText(), new RegExp(name));
  };
  const logout = async () => {
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByLabel('Username', { exact: true }).waitFor();
  };
  const request = async (path, input) => {
    const { csrfToken } = await (await context.request.get(origin + '/ui/session')).json();
    const response = input === undefined ? await context.request.get(origin + path) : await context.request.post(origin + path, { data: input, headers: { origin, 'x-csrf-token': csrfToken } });
    assert.ok(response.ok(), path + ': ' + response.status());
    return response.json();
  };
  const master = new Map();
  for (const name of ['alice', 'bob']) {
    master.set(name, randomBytes(32).toString('hex'));
    compose(['exec', '-T', name, 'node', 'dist/cli/main.js', 'auth', 'unlock'], { input: master.get(name) });
  }
  // Check the actual engine sandbox with command networking enabled, as in default task execution.
  const probeSocket = "const fs=require('node:fs');const net=require('node:net');if(fs.existsSync('/run/devagents-workspace/api.sock') || fs.existsSync('/run/secrets/workspace-db'))process.exit(2);const s=net.connect('/run/devagents-workspace/api.sock');s.on('connect',()=>process.exit(3));s.on('error',()=>process.stdout.write('isolated'));";
  compose(['exec', '-T', '-e', 'DEVAGENTS_PRIVATE_SOCKET_DIR=/run/devagents-workspace', 'alice', 'node', '--input-type=module', '-e',
    `import {CodexValidator} from './dist/engines/codex/validator.js';
     const v=await new CodexValidator('/data').execute('/projects/example',{executable:'node',args:['-e',${JSON.stringify(probeSocket)}]},new AbortController().signal,30000,false);
     if(v.exitCode!==0 || !v.output.includes('isolated')) process.exitCode=1;`]);
  async function connect(name, value) {
    await request('/setup/claude-auth', { attemptId: randomUUID(), method: 'subscription', apiKey: value });
    for (let i = 0; i < 50; i++) {
      const status = await request('/setup/claude-auth');
      if (status.job?.state === 'completed') return;
      if (status.job?.state === 'failed') throw new Error('Credential save failed for ' + name);
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('Timed out saving synthetic credential');
  }
  const values = { alice: randomBytes(24).toString('hex'), bob: randomBytes(24).toString('hex') };
  await login('alice');
  const aliceTeam = await request('/teams', { name: 'Private Alice team', members: [] });
  const aliceProject = await request('/projects', { name: 'Example', path: '/projects/example' });
  await connect('alice', values.alice);
  let sharedId;
  {
    assert.equal((await request('/status')).sharedTaskStorage.backend, 'postgresql');
    const { csrfToken } = await request('/ui/session');
    const headers = { origin, 'x-csrf-token': csrfToken, 'idempotency-key': 'smoke-retry' };
    // An awaiting-mode task exercises the real API/worker handoff without making a model call.
    const response = await context.request.post(origin + '/tasks', { headers, data: { projectId: aliceProject.id, request: 'Private PostgreSQL smoke' } });
    assert.equal(response.status(), 201); sharedId = (await response.json()).id;
    for (let attempt = 0;; attempt++) {
      const evidence = await request('/tasks/' + sharedId + '/evidence');
      if (evidence.some(e => e.kind === 'workflow-status' && e.data.status === 'suspended')) break;
      assert.ok(attempt < 100, 'mode checkpoint was not persisted');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    compose(['exec', '-T', 'alice', 'sh', '-c', 'test ! -e /data/workflows.db && test ! -e /data/devagents.db && test ! -e /data/service-lock.db']);
  }
  await page.evaluate(() => sessionStorage.setItem('devagents.submit.ticket', 'Alice private draft'));
  await logout();
  await login('bob');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('devagents.submit.ticket')), null);
  assert.equal((await context.request.get(origin + '/teams/' + aliceTeam.id)).status(), 404);
  assert.deepEqual(await request('/projects'), []);
  assert.equal((await context.request.get(origin + '/tasks/' + sharedId + '/result')).status(), 404);
  const bobProject = await request('/projects', { name: 'Example', path: '/projects/example' });
  assert.notEqual(bobProject.id, aliceProject.id);
  assert.equal((await request('/setup/claude-auth')).connection.saved, false);
  await connect('bob', randomBytes(24).toString('hex'));
  await connect('bob', values.bob);
  // Recreate each container to discard tmpfs and prove the correct encrypted volume is restored.
  compose(['up', '-d', '--no-build', '--force-recreate', '--no-deps', '--wait', 'alice', 'bob']);
  for (const name of ['alice', 'bob']) {
    compose(['exec', '-T', name, 'node', 'dist/cli/main.js', 'auth', 'unlock'], { input: master.get(name) });
    compose(['exec', '-T', name, 'node', '--input-type=module', '-e',
      "import {claudeCredential} from './dist/engines/claude/credentials.js'; let expected=''; for await(const c of process.stdin) expected+=c; if ((await claudeCredential('/data'))?.value!==expected) process.exitCode=1;"],
      { input: values[name] });
  }
  assert.equal((await request('/projects'))[0].id, bobProject.id);
  await logout();
  await login('alice');
  assert.equal((await request('/projects'))[0].id, aliceProject.id);
  assert.equal((await request('/setup/claude-auth')).connection.saved, true);
  {
    assert.equal((await request('/tasks/' + sharedId)).state, 'awaiting_mode');
    const history = await request('/tasks/' + sharedId + '/evidence');
    assert.equal(history.filter(e => e.kind === 'workflow-started').length, 1);
    await request('/tasks/' + sharedId + '/cancel', {});
    for (let attempt = 0;; attempt++) {
      const saved = await context.request.get(origin + '/tasks/' + sharedId + '/result');
      if (saved.ok()) { assert.equal((await saved.json()).task.state, 'cancelled'); break; }
      assert.equal(saved.status(), 404);
      assert.ok(attempt < 50, 'shared result was not archived');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  console.log('PASS: sandbox socket denial, Chromium sign-in/switch, isolated projects and teams, separate Claude reconnect and vault restore after runtime recreation.');
} finally {
  await browser?.close();
  try { compose(['down', '-v', '--remove-orphans']); }
  finally { rmSync(secretDir, { recursive: true, force: true }); }
}
