import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from '../helpers.js';
import { FakeEngine, FixtureValidator } from '../fixtures/fake-engine.js';
import { TaskRunner } from '../../src/orchestration/runner.js';
import { git } from '../../src/workspace/git.js';
import { Plan } from '../../src/domain/schemas.js';

test('autonomous task executes real fixture tests, separate review and local commit without touching dirty checkout', async () => {
  const f = await fixture(); const engine = new FakeEngine();
  const runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
  try {
    await writeFile(join(f.project, 'README.md'), 'Dirty user work');
    const task = f.service.submit({ projectId: 'fixture', request: 'Greeting', acceptanceCriteria: ['Keep the public interface stable'], mode: 'autonomous' }, 'm2');
    runner.enqueue(task.id); runner.enqueue(task.id);
    await runner.idle();
    const done = f.store.task(task.id);
    assert.equal(done.state, 'completed', JSON.stringify(done.outcome));
    assert.match(done.outcome!.commit!, /^[a-f0-9]{40}$/);
    assert.deepEqual(engine.calls.map(c => c.phase), ['planning', 'implementation', 'review']);
    assert.match(engine.calls[1]!.prompt, /Keep the public interface stable/);
    assert.match(engine.calls[2]!.prompt, /Keep the public interface stable/);
    assert.notEqual(engine.calls[1]!.agent.id, engine.calls[2]!.agent.id);
    assert.deepEqual(engine.calls[2]!.agent.permissions.writePaths, []);
    assert.equal(await readFile(join(f.project, 'README.md'), 'utf8'), 'Dirty user work');
    assert.equal(await git(f.project, ['branch', '--show-current']), 'main');
    assert.equal(await git(done.workspace!.path, ['status', '--porcelain']), '');
    assert.ok(f.store.evidence(task.id).some(e => e.kind === 'validation' && (e.data as { exitCode: number }).exitCode === 0));
    assert.equal(f.store.evidence(task.id).filter(e => e.kind === 'commit-created').length, 1);
  } finally { await runner.stop(); await f.cleanup(); }
});
test('mode and plan approval stop all dependent execution until explicitly resolved', async () => {
  const f = await fixture(); const engine = new FakeEngine(); const runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Greeting' }, 'approval');
    await runner.idle(); assert.equal(engine.calls.length, 0);
    f.service.mode(task.id, 'plan-approval'); await runner.idle();
    const pending = f.store.task(task.id); assert.equal(pending.state, 'awaiting_plan_approval'); assert.equal(engine.calls.length, 1);
    assert.throws(() => f.service.approve(task.id, 0), /Task changed/);
    f.service.approve(task.id, pending.version); await runner.idle();
    assert.equal(f.store.task(task.id).state, 'completed');
  } finally { await runner.stop(); await f.cleanup(); }
});
test('failed real validation triggers a bounded repair before review', async () => {
  const f = await fixture(); const engine = new FakeEngine({ failFirstTest: true }); const runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Greeting', mode: 'autonomous' }, 'repair'); await runner.idle();
    const done = f.store.task(task.id); assert.equal(done.state, 'completed', JSON.stringify(done.outcome)); assert.equal(done.outcome!.repairCycles, 1);
    assert.deepEqual(engine.calls.map(c => c.phase), ['planning', 'implementation', 'implementation', 'review']);
    assert.equal(f.store.evidence(task.id).filter(e => e.kind === 'validation').length, 2);
  } finally { await runner.stop(); await f.cleanup(); }
});
test('review rejection exhausts the repair limit without a commit', async () => {
  const f = await fixture(); const engine = new FakeEngine({ rejectReviews: true }); const runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Greeting', mode: 'autonomous' }, 'reject'); await runner.idle();
    assert.equal(f.store.task(task.id).state, 'failed'); assert.match(f.store.task(task.id).outcome!.error!, /Repair budget exhausted/);
    assert.equal(f.store.evidence(task.id).some(e => e.kind === 'commit-created'), false);
    assert.equal(engine.calls.filter(c => c.phase === 'implementation').length, 2);
  } finally { await runner.stop(); await f.cleanup(); }
});
test('a reviewer mutation invalidates approval before commit', async () => {
  const f = await fixture(); const engine = new FakeEngine({ mutateReview: true }); const runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Greeting', mode: 'autonomous' }, 'tamper'); await runner.idle();
    assert.equal(f.store.task(task.id).state, 'failed'); assert.match(f.store.task(task.id).outcome!.error!, /Files changed during review/);
    assert.equal(f.store.evidence(task.id).some(e => e.kind === 'commit-created'), false);
  } finally { await runner.stop(); await f.cleanup(); }
});
test('cancellation stops a running engine and releases the serial worker slot', async () => {
  const f = await fixture(); const engine = new FakeEngine({ waitForCancel: true }); const runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Greeting', mode: 'autonomous' }, 'cancel');
    const deadline = Date.now() + 10000;
    while (!engine.calls.some(c => c.phase === 'implementation')) { if (Date.now() > deadline) throw new Error('Worker did not start'); await new Promise(r => setTimeout(r, 10)); }
    f.service.cancel(task.id); await runner.idle();
    assert.equal(f.store.task(task.id).state, 'cancelled'); assert.equal(f.store.evidence(task.id).some(e => e.kind === 'commit-created'), false);
    engine.options.waitForCancel = false;
    const next = f.service.submit({ projectId: 'fixture', request: 'Next greeting', mode: 'autonomous' }, 'after-cancel'); await runner.idle();
    assert.equal(f.store.task(next.id).state, 'completed');
  } finally { await runner.stop(); await f.cleanup(); }
});

test('review context cannot bypass a role read scope', async () => {
  const f = await fixture(); const engine = new FakeEngine(); const runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
  const agents = await f.service.agents('fixture');
  f.service.agents = async () => agents.map(a => a.capabilities.includes('review') ? { ...a, permissions: { ...a.permissions, readPaths: ['project:/docs/**'] } } : a);
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Greeting', mode: 'autonomous' }, 'review-scope'); await runner.idle();
    assert.equal(f.store.task(task.id).state, 'failed');
    assert.match(f.store.task(task.id).outcome!.error!, /cannot read/);
    assert.equal(engine.calls.some(c => c.phase === 'review'), false);
  } finally { await runner.stop(); await f.cleanup(); }
});

test('cancellation at commit finalization returns conflict and preserves accurate outcome', async () => {
  const f = await fixture(); const runner = new TaskRunner(f.service, new FakeEngine(), new FixtureValidator()); f.service.attachRunner(runner);
  const record = f.store.record.bind(f.store); let checked = false;
  f.store.record = (id, kind, data) => {
    if (kind === 'commit-intent') { checked = true; assert.throws(() => f.service.cancel(id), /commit is being finalized/); }
    return record(id, kind, data);
  };
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Greeting', mode: 'autonomous' }, 'commit-race'); await runner.idle();
    assert.equal(checked, true); assert.equal(f.store.task(task.id).state, 'completed'); assert.ok(f.store.task(task.id).outcome!.commit);
  } finally { await runner.stop(); await f.cleanup(); }
});

test('approval with outstanding findings cannot bypass repair or create a commit', async () => {
  const f = await fixture(); const engine = new FakeEngine({ contradictoryReview: true });
  const runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Greeting', mode: 'autonomous' }, 'contradictory-review');
    await runner.idle();
    const done = f.store.task(task.id);
    assert.equal(done.state, 'failed'); assert.match(done.outcome!.error!, /Repair budget exhausted/);
    assert.equal(done.outcome!.repairCycles, 1);
    assert.equal(f.store.evidence(task.id).some(e => e.kind === 'commit-created'), false);
  } finally { await runner.stop(); await f.cleanup(); }
});

test('invalid or excessive model path ownership fails before implementation despite relaxed generation hints', async () => {
  for (const path of ['project:/../secret', 'project:/src\\evil', 'project:/bad\0name', '/tmp/escape', 'project:/**']) {
    const f = await fixture(); const engine = new FakeEngine();
    const agents = await f.service.agents('fixture');
    f.service.agents = async () => agents.map(a => a.id === 'general-developer' ? { ...a, permissions: { ...a.permissions, writePaths: ['project:/src/**'] } } : a);
    const execute = engine.execute.bind(engine);
    engine.execute = async request => {
      const result = await execute(request);
      if (request.phase === 'planning') {
        const plan = Plan.parse(result.output); plan.items[0]!.ownedPaths = [path]; return { output: plan };
      }
      return result;
    };
    const runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
    try {
      const task = f.service.submit({ projectId: 'fixture', request: 'Greeting', mode: 'autonomous' }, 'unsafe-planned-path');
      await runner.idle();
      assert.equal(f.store.task(task.id).state, 'failed', path);
      assert.deepEqual(engine.calls.map(c => c.phase), ['planning']);
      assert.equal(f.store.task(task.id).plan, undefined);
      assert.equal(f.store.evidence(task.id).some(e => e.kind === 'commit-created'), false);
    } finally { await runner.stop(); await f.cleanup(); }
  }
});
