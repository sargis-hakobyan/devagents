import test from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync, randomUUID, randomBytes } from 'node:crypto';
import { PgSession } from '../../src/persistence/pg-session.js';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from '../../src/persistence/store.js';
import { LoginAccounts } from '../../src/persistence/login-accounts.js';
import { PasswordLogin } from '../../src/auth/password.js';
import { loginSchema } from '../../src/persistence/login-schema.js';
import { TaskService } from '../../src/orchestration/service.js';
import { TaskRunner } from '../../src/orchestration/runner.js';
import { FakeEngine, FixtureValidator } from '../fixtures/fake-engine.js';
import { legacyWorkspace, legacySnapshot } from '../fixtures/legacy-workspace.js';
import { fixture } from '../helpers.js';

test('local upgrade preserves logins, team revisions, history and a suspended plan across restart', async () => {
  const f = await fixture();
  const path = join(f.dataDir, 'legacy.db');
  const engine = new FakeEngine();
  let runner = new TaskRunner(f.service, engine, new FixtureValidator());
  let imported: Store | undefined;
  try {
    f.service.attachRunner(runner);
    const team = await f.service.createTeam({ name: 'Private team', members: [] });
    await f.service.updateTeam(team.id, team.revision, { name: 'Renamed team', members: [] });
    const task = await f.service.submit({ projectId: 'fixture', request: 'Migrated approval', mode: 'plan-approval' }, 'same-request');
    await runner.idle();
    const pending = await f.store.task(task.id);
    assert.equal(pending.state, 'awaiting_plan_approval');
    await runner.stop();
    await legacyWorkspace(f.store.legacyPath, path, 14);
    await legacySnapshot(f.store.legacyPath, join(f.dataDir, 'workflows.db'), true);
    // The legacy source is an independent installation; relinquish its synthetic run IDs.
    const source = await PgSession.open(f.store.legacyPath);
    try { await source.exec('DELETE FROM mastra_workflow_snapshot; DELETE FROM mastra_workflow_run_owners'); }
    finally { await source.close(); }
    const salt = randomBytes(16).toString('hex');
    const expected = { user: { id: randomUUID(), name: 'Imported', role: 'admin' }, salt,
      hash: scryptSync('fixture-pass', salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }).toString('hex') };
    const legacy = new DatabaseSync(path);
    try {
      legacy.exec(loginSchema);
      legacy.prepare('INSERT INTO users VALUES(?,?,?)').run(expected.user.id, expected.user.name, expected.user.role);
      legacy.prepare('INSERT INTO password_accounts VALUES(?,?,?,?)').run('import-user', expected.user.id, expected.salt, expected.hash);
    } finally { legacy.close(); }
    const before = await readFile(path);
    const login = await LoginAccounts.open(path);
    try {
      const provider = new PasswordLogin(login);
      assert.deepEqual(await provider.authenticate({ username: 'import-user', password: 'fixture-pass' }), expected.user);
      assert.deepEqual(await login.passwordAccount('import-user'), expected);
    } finally { await login.close(); }

    for (let restart = 0; restart < 2; restart++) {
      imported = await Store.open(path);
      assert.deepEqual(await imported.events(task.id), await f.store.events(task.id));
      assert.deepEqual(await imported.teamRevisions(team.id), await f.store.teamRevisions(team.id));
      assert.deepEqual(await imported.evidence(task.id), await f.store.evidence(task.id));
      const service = await TaskService.create(imported, f.service.config, f.dataDir);
      runner = new TaskRunner(service, engine, new FixtureValidator());
      service.attachRunner(runner);
      await runner.recover(); await runner.idle();
      assert.equal((await runner.workflows.state(task.id))?.status, 'suspended');
      assert.deepEqual(await imported.task(task.id), pending);
      if (restart === 1) {
        await assert.rejects(async () => await service.approve(task.id, pending.version - 1), /Task changed/);
        await service.approve(task.id, pending.version);
        await runner.enqueue(task.id);
        await runner.idle();
        assert.equal((await imported.task(task.id)).state, 'completed');
        assert.equal((await imported.evidenceOf(task.id, ['commit-created'])).length, 1);
        assert.equal(engine.calls.filter(c => c.phase === 'implementation').length, 1);
      }
      await runner.stop(); await imported.close();
    }
    assert.deepEqual(await readFile(path), before);
  } finally { await runner.stop(); await imported?.close(); await f.cleanup(); }
});

test('version 9 execution settings preserve the QA flag and revision on upgrade', async () => {
  const f = await fixture();
  const path = join(f.dataDir, 'qa-settings.db');
  try {
    await legacyWorkspace(f.store.legacyPath, path, 9);
    const legacy = new DatabaseSync(path);
    try {
      legacy.exec('CREATE TABLE execution_settings (id INTEGER PRIMARY KEY, qa_enabled INTEGER, version INTEGER); INSERT INTO execution_settings VALUES (1, 0, 7)');
    } finally { legacy.close(); }
    const imported = await Store.open(path);
    try {
      const db = await PgSession.open(path);
      try {
        const row = await db.prepare('SELECT data FROM execution_settings WHERE id=1').get();
        assert.deepEqual(JSON.parse(String(row?.data)), { qa_enabled: 0, version: 7 });
      } finally { await db.close(); }
    } finally { await imported.close(); }
  } finally { await f.cleanup(); }
});

test('a failed import can be repaired and retried, and a bound volume refuses a replacement database', async () => {
  const f = await fixture();
  const path = join(f.dataDir, 'retry.db');
  try {
    await legacyWorkspace(f.store.legacyPath, path, 14);
    const source = new DatabaseSync(path);
    try {
      source.exec("INSERT INTO projects VALUES('duplicate', (SELECT path FROM projects LIMIT 1), '{}')");
      await assert.rejects(async () => await Store.open(path), /duplicate key/);
      source.exec("DELETE FROM projects WHERE id='duplicate'");
    } finally { source.close(); }
    const imported = await Store.open(path);
    try { assert.deepEqual(await imported.projects(), await f.store.projects()); } finally { await imported.close(); }
    const { PgSession } = await import('../../src/persistence/pg-session.js');
    const db = await PgSession.open(path);
    try { await db.exec("UPDATE schema_versions SET store_id=gen_random_uuid() WHERE component='workspace'"); } finally { await db.close(); }
    await assert.rejects(async () => await Store.open(path), /Restore the PostgreSQL database paired/);
  } finally { await f.cleanup(); }
});

test('projected PostgreSQL history can read engine output with NUL and isolated UTF-16 code units', async () => {
  const f = await fixture();
  try {
    const task = await f.service.submit({ projectId: 'fixture', request: 'Projection' }, 'projection');
    const summary = 'hello\0world\ud800';
    await f.store.record(task.id, 'run-completed', { runId: 'original', output: { summary }, usagePrice: null });
    await f.store.record(task.id, 'progress', { kind: 'command', text: summary });
    assert.equal((await f.store.executionEvidence(task.id))[0]?.data.summary, summary);
    const usage = await f.store.usageEvidence(task.id);
    assert.equal(usage.length, 1);
    assert.equal((usage[0]!.data as { usagePrice: unknown }).usagePrice, null);
  } finally { await f.cleanup(); }
});
