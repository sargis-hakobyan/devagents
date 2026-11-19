import { workspaceCheckpoints } from '../../src/persistence/postgres-checkpoints.js';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { CredentialVault } from '../../src/security/credential-vault.js';
import { PostgresTasks } from '../../src/persistence/postgres-tasks.js';
import { SharedTasks } from '../../src/orchestration/shared-tasks.js';
import { TaskRunner } from '../../src/orchestration/runner.js';
import { TaskService } from '../../src/orchestration/service.js';
import { Store } from '../../src/persistence/store.js';
import { createApi } from '../../src/api/server.js';
import { verifyPublicUpgrade } from '../fixtures/legacy-postgres.js';
import { legacySnapshot } from '../fixtures/legacy-workspace.js';
import { PgSession, workspaceOptions, workspaceConnection } from '../../src/persistence/pg-session.js';
import { fixture } from '../helpers.js';
import { FakeEngine, FixtureValidator } from '../fixtures/fake-engine.js';
import type { EngineRequest } from '../../src/domain/engine.js';

const exec = promisify(execFile);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('PostgreSQL claims and archives two private workspace tasks across retries and worker restart', {
  skip: process.env.DEVAGENTS_TEST_POSTGRES !== '1' && 'Run npm run test:postgres with Docker',
  timeout: 120000,
}, async () => {
  const name = 'devagents-pg-test-' + randomUUID();
  const adminPassword = randomBytes(32).toString('hex');
  await exec('docker', ['run', '-d', '--rm', '--tmpfs', '/var/lib/postgresql/data:size=256m', '--name', name, '-e', 'POSTGRES_PASSWORD', '-p', '127.0.0.1::5432', 'postgres:17-alpine'], {
    env: { ...process.env, POSTGRES_PASSWORD: adminPassword },
  });
  let releaseWorkers: () => void = () => {};
  const proceed = new Promise<void>(resolve => { releaseWorkers = resolve; });
  const cleanup: (() => Promise<void>)[] = [];
  try {
    const port = Number((await exec('docker', ['port', name, '5432/tcp'])).stdout.trim().split(':').at(-1));
    const config = { host: '127.0.0.1', port, database: 'postgres' };
    const admin = new pg.Pool({ ...config, user: 'postgres', password: adminPassword });
    cleanup.push(() => admin.end());
    for (let i = 0;; i++) {
      try { await admin.query('SELECT 1'); break; }
      catch (error) { if (i >= 100) throw error; await delay(150); }
    }
    const migrated = await verifyPublicUpgrade(admin);
    const password = randomBytes(32).toString('hex');
    const user = 'fixture_workers';
    await admin.query(`CREATE ROLE fixture_workers LOGIN PASSWORD '${password}' IN ROLE devagents_runtime`);
    // Point the domain store, workflow adapter and archive at this same disposable database.
    Object.assign(process.env, { PGHOST: config.host, PGPORT: String(port), PGDATABASE: config.database,
      PGUSER: user, PGPASSWORD: password, DEVAGENTS_TEST_DATABASE: '1' });
    for (const key of ['DEVAGENTS_POSTGRES_HOST','DEVAGENTS_POSTGRES_DATABASE','DEVAGENTS_POSTGRES_USER',
      'DEVAGENTS_POSTGRES_PASSWORD_FILE','DEVAGENTS_WORKSPACE_ID']) delete process.env[key];
    // Both connections use the same login, database and tables. Identical old keys remain independent.
    for (const owner of migrated) {
      const connection = new pg.Pool({ ...config, user, password, options: workspaceOptions(owner) });
      try {
        assert.deepEqual((await connection.query('SELECT id,workspace_id FROM public.projects')).rows, [{ id: 'project', workspace_id: owner }]);
        assert.equal((await connection.query("INSERT INTO public.events(task_id,data) VALUES ('task','{}') RETURNING sequence")).rows[0].sequence, '8');
        assert.equal((await connection.query("UPDATE public.tasks SET state='failed' WHERE workspace_id<>workspace_context()")).rowCount, 0);
        await assert.rejects(connection.query('SELECT hash FROM public.password_accounts'), { code: '42501' });
      } finally { await connection.end(); }
    }
    const arrived = new Set<string>();
    let resume!: () => void;
    const together = new Promise<void>(resolve => { resume = resolve; });
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Tasks did not overlap')), 40000); });
    cleanup.push(async () => { clearTimeout(timer); resume(); });
    async function workspace(importLegacy = false) {
      const f = await fixture();
      const owner = workspaceConnection(f.store.legacyPath).workspaceId;
      cleanup.push(f.cleanup);
      await f.store.bindWorkspaceOwner(owner);
      const db = await PostgresTasks.connect({ ...config, user, password }, owner);
      let legacyId: string | undefined;
      if (importLegacy) {
        const old = new TaskRunner(f.service, new FakeEngine(), new FixtureValidator());
        f.service.attachRunner(old);
        legacyId = (await f.service.submit({ projectId: 'fixture', request: 'Existing approval', mode: 'plan-approval' }, 'before-pg')).id;
        await old.idle();
        assert.equal((await old.workflows.state(legacyId))?.status, 'suspended');
        await old.stop();
        await legacySnapshot(f.store.legacyPath, join(f.dataDir, 'workflows.db'));
        const session = await PgSession.open(f.store.legacyPath);
        try { await session.exec('DELETE FROM checkpoint_binding; DELETE FROM mastra_workflow_snapshot; DELETE FROM mastra_workflow_run_owners'); } finally { await session.close(); }
      }
      const sharedTasks = await SharedTasks.create(f.service, db);
      const vault = new CredentialVault(f.dataDir, join(f.root, 'fixture-runtime'), 'claude');
      const expectedCredential = randomBytes(24).toString('hex');
      await vault.unlock(randomBytes(32).toString('hex'));
      await mkdir(join(vault.runtimeDir, 'claude'), { recursive: true });
      await writeFile(vault.auth, JSON.stringify({ value: expectedCredential }), { mode: 0o600 });
      await vault.seal();
      let implementations = 0, admissions = 0;
      f.service.onAdmitted(() => { admissions++; });
      const engine = new class extends FakeEngine {
        override async execute(req: EngineRequest) {
          if (req.phase === 'implementation') {
            implementations++;
            const credential = JSON.parse(await readFile(vault.auth, 'utf8'));
            assert.ok(credential.value === expectedCredential, 'engine used its workspace credential');
            assert.ok(req.cwd.includes(f.root.split('/').at(-1)! + '/'));
            arrived.add(owner);
            if (arrived.size === 2) resume();
            await Promise.race([proceed, timeout]);
          }
          return super.execute(req);
        }
      }();
      if (importLegacy) {
        const interrupted = mock.method(f.store, 'bindCheckpoints', () => { throw new Error('fixture interrupted import'); });
        try { await assert.rejects(db.checkpoints(f.store, f.dataDir), /fixture interrupted import/); }
        finally { interrupted.mock.restore(); }
      }
      const runner = new TaskRunner(f.service, engine, new FixtureValidator(), undefined, { workflowStorage: await db.checkpoints(f.store, f.dataDir) });
      f.service.attachRunner(runner);
      const wrongStorage = workspaceCheckpoints(f.store, f.dataDir);
      try { await assert.rejects(wrongStorage.init(), /requires its PostgreSQL/); } finally { await wrongStorage.close().catch(() => {}); }
      const server = await createApi(f.service, 'fixture-token', { sharedTasks });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
      let stopped = false;
      async function stop() {
        if (stopped) return; stopped = true;
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
        await runner.stop(); await sharedTasks.stop();
      }
      cleanup.push(stop);
      const api = (path: string, body?: unknown) => fetch(url + path, {
        method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer fixture-token', 'content-type': 'application/json', 'idempotency-key': 'same-key' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { f, legacyId, owner, db, password, sharedTasks, runner, stop, api, admissions: () => admissions, implementations: () => implementations };
    }
    const a = await workspace(true), b = await workspace();
    assert.equal((await a.runner.workflows.state(a.legacyId!))?.status, 'suspended', 'existing approval checkpoint was imported');
    await rename(join(a.f.dataDir, 'workflows.db'), join(a.f.dataDir, 'old-checkpoints.db'));
    const input = { projectId: 'fixture', request: 'Private greeting', mode: 'autonomous' };
    // Simulate death after PostgreSQL commits its claim but before local release. A running
    // scheduler still cannot claim the task from SQLite. Restart reconciliation reuses the claim.
    await admin.query('REVOKE INSERT (owner_id,task_id,retry_hash,input_hash,submission) ON public.task_runs FROM devagents_runtime');
    const failedSubmission = await a.api('/tasks', input);
    assert.equal(failedSubmission.status, 503);
    const [prepared] = await a.f.store.tasks();
    assert.ok(prepared);
    assert.equal(a.implementations(), 0); assert.equal(a.admissions(), 0);
    await admin.query('GRANT INSERT (owner_id,task_id,retry_hash,input_hash,submission) ON public.task_runs TO devagents_runtime');
    const pending = (await a.f.store.sharedHandoff(prepared.id))!;
    assert.equal(await a.f.store.claimDispatch('premature'), undefined);
    const handoff = { ...pending, id: prepared.id, snapshot: JSON.parse(pending.snapshot!) };
    await a.db.publish(handoff);
    const queued = await admin.query('SELECT claim_id FROM public.task_runs WHERE owner_id=$1', [a.owner]);
    assert.equal(queued.rows[0].claim_id, null, 'submitting only publishes work');
    await a.db.claim(handoff.id, handoff.claimId);
    await assert.rejects(a.db.claim(handoff.id, randomUUID()), /different work/);
    assert.equal(await a.f.store.claimDispatch('still-premature'), undefined);
    const initial = await admin.query('SELECT claim_id FROM public.task_runs WHERE owner_id=$1', [a.owner]);
    a.sharedTasks.start(); b.sharedTasks.start();
    const submitted = await Promise.all([a.api('/tasks', input), b.api('/tasks', input)]);
    for (const r of submitted) assert.equal(r.status, 201);
    const [first, second] = await Promise.all(submitted.map(r => r.json()));
    assert.equal(first.id, prepared.id); assert.notEqual(first.id, second.id);
    for (const [w, id] of [[a, first.id], [b, second.id]] as const) {
      const again = await w.api('/tasks', input);
      assert.equal((await again.json()).id, id);
      assert.equal((await w.api('/tasks', { ...input, request: 'Conflicting input' })).status, 409);
    }
    await Promise.race([together, timeout]);
    try {
      assert.equal((await a.f.store.task(first.id)).state, 'running');
      await a.f.store.record(first.id, 'live-log', { text: 'x'.repeat(20000), message: 'fixture-secret-value' });
      const last = (await a.f.store.lastEvidence(first.id, 'live-log'))!;
      const page = await (await a.api('/tasks/' + first.id + '/evidence?after=' + (last.sequence - 1) + '&limit=1')).json();
      assert.equal(page[0].sequence, last.sequence);
      assert.equal(page[0].truncated, true);
      const detail = await (await a.api('/tasks/' + first.id + '/evidence/' + last.sequence)).json();
      assert.equal(detail.data.text.length, 20000);
      assert.ok(!JSON.stringify(detail).includes('fixture-secret-value'));
      assert.deepEqual(await (await a.api('/tasks/' + first.id + '/events?after=1&limit=2')).json(), await a.f.store.events(first.id, 1, 2));
      assert.equal((await b.api('/tasks/' + first.id + '/evidence/' + last.sequence)).status, 404);
      await admin.query('REVOKE INSERT ON public.task_history FROM devagents_runtime');
      await a.f.store.record(first.id, 'journal-during-outage', { retained: true });
      try {
        assert.equal((await a.api('/tasks/' + first.id + '/evidence')).status, 503);
      } finally { await admin.query('GRANT INSERT ON public.task_history TO devagents_runtime'); }
      const recovered = await (await a.api('/tasks/' + first.id + '/evidence?after=' + last.sequence)).json();
      assert.equal(recovered.filter((r: {kind: string}) => r.kind === 'journal-during-outage').length, 1);
    } finally { releaseWorkers(); }
    await Promise.all([a.runner.idle(), b.runner.idle()]);
    for (const [w, id, foreign] of [[a, first.id, second.id], [b, second.id, first.id]] as const) {
      assert.equal(w.implementations(), 1); assert.equal(w.admissions(), 1);
      const response = await w.api('/tasks/' + id + '/result'); assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.ownerId, w.owner); assert.equal(result.task.state, 'completed');
      assert.ok(result.task.outcome.commit); assert.ok(result.diff.files.length);
      for (const suffix of ['/result', '/evidence', '/diff']) assert.equal((await w.api('/tasks/' + foreign + suffix)).status, 404);
      const worker = new pg.Pool({ ...config, user, password: w.password, options: workspaceOptions(w.owner) });
      try {
        const rows = await worker.query('SELECT owner_id,task_id,claim_id FROM public.task_runs');
        assert.equal(rows.rowCount, 1); assert.equal(rows.rows[0].task_id, id); assert.equal(rows.rows[0].owner_id, w.owner);
        if (w === a) assert.equal(rows.rows[0].claim_id, initial.rows[0].claim_id);
        const history = await worker.query('SELECT DISTINCT owner_id FROM public.task_history');
        assert.deepEqual(history.rows, [{ owner_id: w.owner }]);
        const other = w === a ? b : a;
        assert.equal((await worker.query('SELECT run_id FROM public.mastra_workflow_snapshot WHERE workspace_id=$1', [other.owner])).rowCount, 0);
        await assert.rejects(worker.query("UPDATE public.task_history SET kind='changed'"), { code: '42501' });

      } finally { await worker.end(); }
      await w.stop();
      // A fresh store, PG connection and worker recover the result without running an engine again.
      const reopened = await Store.open(join(w.f.dataDir, 'test.db'));
      const service = await TaskService.create(reopened, w.f.service.config, w.f.dataDir);
      const db = await PostgresTasks.connect({ ...config, user, password: w.password }, w.owner);
      const shared = await SharedTasks.create(service, db);
      const freshEngine = new FakeEngine();
      const runner = new TaskRunner(service, freshEngine, new FixtureValidator(), undefined, { startPaused: true, workflowStorage: await db.checkpoints(reopened, w.f.dataDir) });
      service.attachRunner(runner);
      try {
        await runner.recover(); await runner.idle();
        assert.equal((await shared.result(id))?.task.outcome?.commit, result.task.outcome.commit);
        assert.equal(await shared.result(foreign), undefined);
        assert.equal(freshEngine.calls.length, 0);
        assert.deepEqual(await shared.history.events(id, 0, 1000), await reopened.events(id));
        if (w.legacyId) {
          const pending = await reopened.task(w.legacyId);
          assert.equal(pending.state, 'awaiting_plan_approval');
          assert.equal((await runner.workflows.state(w.legacyId))?.status, 'suspended');
          await assert.rejects(async () => await service.approve(w.legacyId!, pending.version - 1), /Task changed/);
          await service.approve(w.legacyId, pending.version);
          await runner.idle();
          assert.equal((await reopened.task(w.legacyId)).state, 'completed');
          assert.equal(freshEngine.calls.filter(c => c.phase === 'planning').length, 0);
          assert.equal(freshEngine.calls.filter(c => c.phase === 'implementation').length, 1);
          assert.equal((await reopened.evidenceOf(w.legacyId, ['commit-created'])).length, 1);
        }
      } finally { await runner.stop(); await shared.stop(); await reopened.close(); }
    }
  } finally {
    releaseWorkers();
    try { for (const close of cleanup.reverse()) await close(); }
    finally { await exec('docker', ['rm', '-f', '-v', name]); }
  }
});
