import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fixture } from '../helpers.js';
import { TaskRunner } from '../../src/orchestration/runner.js';
import { FakeEngine, FixtureValidator } from '../fixtures/fake-engine.js';
import { STARTER_TEAM_ID, STARTER_ROLES } from '../../src/domain/starter-team.js';
import { Store } from '../../src/persistence/store.js';
import { TaskService } from '../../src/orchestration/service.js';
import { Config } from '../../src/domain/schemas.js';

test('starter bootstrap is persistent and idempotent, defaults new projects and freezes normal task snapshots', async () => {
  const f = await fixture();
  const engine = new FakeEngine();
  const execute = engine.execute.bind(engine);
  engine.execute = async request => {
    const result = await execute(request);
    if (request.phase === 'planning') {
      (result.output as { items: { assignedAgent: string }[] }).items[0]!.assignedAgent = 'backend-developer';
    }
    return result;
  };
  const runner = new TaskRunner(f.service, engine, new FixtureValidator());
  try {
    const legacy = f.service.submit({ projectId: 'fixture', request: 'Already submitted' }, 'legacy');
    const starter = await f.service.initializeStarterTeam();
    assert.equal(starter.readiness.ready, true); assert.deepEqual(starter.members.map(m => m.id), [...STARTER_ROLES]);
    assert.equal(f.store.project('fixture').defaultTeamId, STARTER_TEAM_ID);
    assert.equal(f.store.task(legacy.id).team, undefined);
    f.service.attachRunner(runner);
    const task = f.service.submit({ projectId: 'fixture', request: 'Use the starter', mode: 'autonomous' }, 'starter');
    await runner.idle();
    assert.equal(f.store.task(task.id).state, 'completed', JSON.stringify(f.store.task(task.id).outcome));
    assert.equal(task.team?.id, starter.id); assert.equal(task.team?.modelPinned, false);
    const edited = f.service.updateTeam(starter.id, 1, { name: 'My edited starter', description: starter.description, members: starter.members });
    assert.equal((await f.service.initializeStarterTeam()).name, edited.name);
    assert.equal(f.store.teams('all').length, 1); assert.equal(f.store.teamRevisions(starter.id).length, 2);
    assert.equal(f.store.task(task.id).team?.revision, 1);
    const other = join(f.root, 'second'); execFileSync('git', ['clone', '-q', f.project, other]);
    assert.equal((await f.service.registerProject({ id: 'second', path: other })).defaultTeamId, starter.id);
    const db = new Store(join(f.dataDir, 'test.db'));
    try {
      const service = new TaskService(db, f.service.config, f.dataDir);
      assert.equal((await service.initializeStarterTeam()).revision, 2); assert.equal(db.teams('all').length, 1);
    } finally { db.close(); }
  } finally { await runner.stop(); await f.cleanup(); }
});

test('starter bootstrap preserves custom and cleared defaults and never restores an archived team', async () => {
  const f = await fixture();
  try {
    const members = (await f.service.templates()).filter(m => STARTER_ROLES.includes(m.id as typeof STARTER_ROLES[number]));
    const custom = f.service.createTeam({ name: 'Custom team', members });
    f.service.setProjectDefaultTeam('fixture', custom.id, 0);
    const starter = await f.service.initializeStarterTeam();
    assert.equal(f.store.project('fixture').defaultTeamId, custom.id);
    const cleared = f.service.setProjectDefaultTeam('fixture', null, 1);
    await f.service.initializeStarterTeam();
    assert.deepEqual(f.store.project('fixture'), cleared);
    assert.deepEqual(await f.service.registerProject({ id: 'fixture', path: f.project }), cleared);
    f.service.setTeamArchived(starter.id, 1, true);
    assert.equal((await f.service.initializeStarterTeam()).archived, true);
    const other = join(f.root, 'second'); execFileSync('git', ['clone', '-q', f.project, other]);
    assert.equal((await f.service.registerProject({ id: 'second', path: other })).defaultTeamId, undefined);
    assert.equal(f.store.teams('all').length, 2);
  } finally { await f.cleanup(); }
});

test('unavailable runtime defaults leave the starter as a draft without selecting it', async () => {
  const f = await fixture();
  try {
    const service = new TaskService(f.store, Config.parse({ schemaVersion: 1, defaultEngine: 'claude-code' }), f.dataDir);
    assert.equal((await service.initializeStarterTeam()).readiness.ready, false);
    assert.equal(f.store.project('fixture').defaultTeamId, undefined);
  } finally { await f.cleanup(); }
});
