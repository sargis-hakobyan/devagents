import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture } from '../helpers.js';
import { FakeEngine, FixtureValidator } from '../fixtures/fake-engine.js';
import { TaskRunner } from '../../src/orchestration/runner.js';
import { TaskService } from '../../src/orchestration/service.js';
import { Store } from '../../src/persistence/store.js';
import { Config, type TeamMember } from '../../src/domain/schemas.js';
import type { CodingEngine, EngineRequest, EngineResult } from '../../src/domain/engine.js';

/** Blocks only the implementation of the request marked [block] until that task is cancelled; everything else behaves like the fake engine. */
class GatedEngine extends FakeEngine {
  override async execute(request: EngineRequest): Promise<EngineResult> {
    if (request.phase === 'implementation' && request.prompt.includes('[block]')) {
      this.calls.push(request);
      await new Promise<void>((_, reject) => { const abort = () => reject(new Error('blocked task cancelled')); if (request.signal.aborted) abort(); else request.signal.addEventListener('abort', abort, { once: true }); });
    }
    return super.execute(request);
  }
}
import { git } from '../../src/workspace/git.js';

async function roster(service: TaskService, ids: string[]): Promise<TeamMember[]> {
  const templates = await service.templates();
  return ids.map(id => { const t = templates.find(x => x.id === id); assert.ok(t, id); return t; });
}

test('a team task runs with its frozen roster and an excluded registry agent cannot be assigned', async () => {
  const f = await fixture(); const engine = new FakeEngine(); const runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
  try {
    // The fake planner always assigns general-developer; a team that renamed its developer excludes it.
    const members = await roster(f.service, ['tech-lead', 'general-developer', 'code-reviewer']);
    const renamed = f.service.createTeam({ name: 'Renamed developer', members: members.map(m => m.id === 'general-developer' ? { ...m, id: 'website-developer', name: 'Website developer' } : m) });
    assert.equal(renamed.readiness.ready, true);
    const blocked = f.service.submit({ projectId: 'fixture', request: 'Greeting', mode: 'autonomous', teamId: renamed.id }, 'excluded');
    await runner.idle();
    const failed = f.store.task(blocked.id);
    assert.equal(failed.state, 'failed'); assert.match(failed.outcome!.error!, /No available agent satisfies greeting/);
    assert.deepEqual(engine.calls.map(c => c.phase), ['planning'], 'nothing executes after the plan names an agent outside the team');
    // The same request with a team that contains the developer completes; the engine sees team members, not registry agents.
    const team = f.service.createTeam({ name: 'Website team', members: members.map(m => m.id === 'code-reviewer' ? { ...m, name: 'Team reviewer', instructions: '# Team reviewer\nReview strictly.' } : m) });
    const task = f.service.submit({ projectId: 'fixture', request: 'Greeting', mode: 'autonomous', teamId: team.id }, 'included');
    await runner.idle();
    const done = f.store.task(task.id);
    assert.equal(done.state, 'completed', JSON.stringify(done.outcome));
    const review = engine.calls.find(c => c.phase === 'review' && c.cwd === done.workspace!.path)!;
    assert.equal(review.agent.name, 'Team reviewer'); assert.match(review.prompt, /^# Team reviewer\nReview strictly\./);
    assert.deepEqual(engine.calls.filter(c => c.cwd === done.workspace!.path).map(c => c.provider.id), ['openai', 'openai', 'openai']);
    assert.equal(done.team!.revision, 1); assert.equal(done.agents!.length, 3);
    assert.ok(f.store.events(task.id).some(e => /team "Website team" revision 1 frozen/.test(e.reason)));
  } finally { await runner.stop(); await f.cleanup(); }
});

test('queued, awaiting-mode and recovering team tasks keep their original roster through team edits, archiving and config changes', async () => {
  const f = await fixture();
  const config = Config.parse({ schemaVersion: 1 });
  const service = new TaskService(f.store, config, f.dataDir);
  const engine = new GatedEngine(); const runner = new TaskRunner(service, engine, new FixtureValidator()); service.attachRunner(runner);
  let recoveredRunner: TaskRunner | undefined; let reopened: Store | undefined;
  try {
    const members = await roster(service, ['tech-lead', 'general-developer', 'code-reviewer']);
    const team = service.createTeam({ name: 'Website team', members: members.map(m => m.id === 'code-reviewer' ? { ...m, name: 'Original reviewer' } : m) });
    const active = service.submit({ projectId: 'fixture', request: 'Blocking [block]', mode: 'autonomous', teamId: team.id }, 'blocking');
    const queued = service.submit({ projectId: 'fixture', request: 'Queued', mode: 'autonomous', teamId: team.id }, 'queued');
    const awaiting = service.submit({ projectId: 'fixture', request: 'Awaiting mode', teamId: team.id }, 'awaiting');
    // Wait until the blocking implementation holds the runner.
    for (let i = 0; i < 200 && !engine.calls.some(c => c.phase === 'implementation'); i++) await delay(25);
    assert.ok(engine.calls.some(c => c.phase === 'implementation'));
    // Everything that could change the roster changes: the team, its archive flag, and the runtime defaults.
    const edited = service.updateTeam(team.id, 1, { name: 'Website team', description: '', members: members.map(m => m.id === 'code-reviewer' ? { ...m, name: 'Changed reviewer' } : m) });
    service.setTeamArchived(team.id, edited.revision, true);
    config.providers.push({ id: 'other', kind: 'openai', auth: 'login' }); config.defaultProvider = 'other'; config.defaultModel = 'changed-model';
    service.cancel(active.id); await runner.idle();
    assert.equal(f.store.task(active.id).state, 'cancelled');
    // The queued task ran after the edits with the frozen revision-1 roster and provider.
    const ranQueued = f.store.task(queued.id);
    assert.equal(ranQueued.state, 'completed', JSON.stringify(ranQueued.outcome));
    assert.equal(ranQueued.team!.revision, 1); assert.equal(ranQueued.team!.members.find(m => m.id === 'code-reviewer')!.name, 'Original reviewer');
    const queuedCalls = engine.calls.filter(c => c.cwd === ranQueued.workspace!.path);
    assert.equal(queuedCalls.length, 3); assert.ok(queuedCalls.every(c => c.provider.id === 'openai' && c.agent.model === 'default'));
    assert.equal(queuedCalls.find(c => c.phase === 'review')!.agent.name, 'Original reviewer');
    // The awaiting-mode task is still frozen; the archived team does not stop it once the mode is chosen.
    assert.equal(f.store.task(awaiting.id).team!.revision, 1);
    await runner.stop();
    // Restart recovery: a second process opens the same database and continues with the same snapshot.
    reopened = new Store(join(f.dataDir, 'test.db'));
    const recoveredService = new TaskService(reopened, Config.parse({ schemaVersion: 1, defaultProvider: 'other', providers: [{ id: 'other', kind: 'openai', auth: 'login' }] }), f.dataDir);
    const recoveredEngine = new FakeEngine(); recoveredRunner = new TaskRunner(recoveredService, recoveredEngine, new FixtureValidator()); recoveredService.attachRunner(recoveredRunner);
    reopened.recover();
    recoveredService.mode(awaiting.id, 'autonomous'); await recoveredRunner.idle();
    const done = reopened.task(awaiting.id);
    assert.equal(done.state, 'completed', JSON.stringify(done.outcome));
    assert.equal(done.team!.revision, 1);
    assert.ok(recoveredEngine.calls.length >= 3); assert.ok(recoveredEngine.calls.every(c => c.provider.id === 'openai'), 'the live config no longer knows openai; the snapshot does');
    assert.equal(recoveredEngine.calls.find(c => c.phase === 'review')!.agent.name, 'Original reviewer');
  } finally { await runner.stop(); await recoveredRunner?.stop(); reopened?.close(); await f.cleanup(); }
});

test('a multi-item plan that assigns an agent outside the team fails before any worker starts', async () => {
  const f = await fixture();
  const calls: EngineRequest[] = [];
  const engine: CodingEngine = {
    id: 'codex', async preflight() {},
    async execute(r) {
      calls.push(r);
      const branch = await git(r.cwd, ['branch', '--show-current']);
      return { output: { summary: 'Two modules', risks: [], integration: { assignedAgent: 'general-developer', validation: [{ executable: 'node', args: ['--test'] }] }, items: ['a', 'b'].map(id => ({ id, title: id, description: id, acceptanceCriteria: ['passes'], dependsOn: [], requiredCapabilities: ['implementation'], assignedAgent: id === 'a' ? 'general-developer' : 'backend-developer', projectId: 'fixture', branch: `${branch}-${id}`, ownedPaths: [`project:/${id}/**`], validation: [{ executable: 'node', args: ['--test'] }] })) } };
    },
  };
  const runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
  try {
    const team = f.service.createTeam({ name: 'No backend', members: await roster(f.service, ['tech-lead', 'general-developer', 'code-reviewer']) });
    const task = f.service.submit({ projectId: 'fixture', request: 'Two modules', mode: 'autonomous', teamId: team.id }, 'dag-excluded');
    await runner.idle();
    const failed = f.store.task(task.id);
    assert.equal(failed.state, 'failed'); assert.match(failed.outcome!.error!, /No available agent satisfies b/);
    assert.deepEqual(calls.map(c => c.phase), ['planning']);
    assert.equal(f.store.workItems(task.id).length, 0);
    // The legacy path still resolves the registry, where backend-developer exists, so the same plan is accepted.
    const legacy = f.service.submit({ projectId: 'fixture', request: 'Two modules', mode: 'plan-approval' }, 'dag-legacy');
    await runner.idle();
    assert.equal(f.store.task(legacy.id).state, 'awaiting_plan_approval');
    assert.equal(f.store.task(legacy.id).agents!.length, 6, 'legacy agents are snapshotted at worktree creation');
  } finally { await runner.stop(); await f.cleanup(); }
});
