import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from '../helpers.js';
import { FakeEngine, FixtureValidator } from '../fixtures/fake-engine.js';
import { TaskRunner } from '../../src/orchestration/runner.js';
import { git } from '../../src/workspace/git.js';
import { Plan } from '../../src/domain/schemas.js';
import { TaskService } from '../../src/orchestration/service.js';
import { Store } from '../../src/persistence/store.js';

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

test('model prompts keep code syntax from the request, plan, diff and review findings while evidence still redacts secret values', async () => {
  const f = await fixture(); const engine = new FakeEngine();
  const code = 'const token: string = session.token; password: string; apiKey = loadKey();';
  const execute = engine.execute.bind(engine); let reviews = 0;
  engine.execute = async request => {
    const result = await execute(request);
    if (request.phase === 'planning') { const plan = Plan.parse(result.output); plan.items[0]!.description = `Type ${code}`; return { output: plan }; }
    if (request.phase === 'review' && ++reviews === 1) return { output: { approved: false, summary: 'Needs a type', findings: [`Declare ${code} explicitly`] } };
    return result;
  };
  const runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
  try {
    const task = f.service.submit({ projectId: 'fixture', request: `Add ${code} without fixture-secret-value`, acceptanceCriteria: [`Keep ${code}`], mode: 'autonomous' }, 'prompt-syntax');
    await runner.idle();
    const done = f.store.task(task.id);
    assert.equal(done.state, 'completed', JSON.stringify(done.outcome));
    assert.equal(done.request, `Add ${code} without [REDACTED]`);
    assert.equal(done.plan!.items[0]!.description, `Type ${code}`);
    assert.deepEqual(engine.calls.map(c => c.phase), ['planning', 'implementation', 'review', 'implementation', 'review']);
    const [, implementation, review, repair] = engine.calls;
    for (const call of [implementation!, review!, repair!]) {
      assert.ok(call.prompt.includes(code), `${call.phase} prompt must keep code syntax`);
      assert.doesNotMatch(call.prompt, /fixture-secret-value/);
    }
    assert.ok(repair!.prompt.includes(`Declare ${code} explicitly`), 'review findings reach the repairing implementer unchanged');
    assert.ok(review!.prompt.includes('greeting.cjs'), 'review prompt includes the diff');
    const evidence = JSON.stringify(f.store.evidence(task.id));
    assert.doesNotMatch(evidence, /fixture-secret-value/);
    assert.doesNotMatch(JSON.stringify(f.store.events(task.id)), /fixture-secret-value/);
  } finally { await runner.stop(); await f.cleanup(); }
});

test('plan approval is never requested for a plan that could not execute', async () => {
  const scenarios: { name: string; pattern: RegExp; platform?: NodeJS.Platform; agents?: (a: Awaited<ReturnType<typeof fixture>>['service']['agents']) => void; plan?: (plan: ReturnType<typeof Plan.parse>) => void }[] = [
    { name: 'unsupported inline validation command', pattern: /Validation supports/, plan: plan => { plan.items[0]!.validation = [{ executable: 'node', args: ['-e', 'process.exit(0)'] }]; } },
    { name: 'exact-file write grant on Linux', pattern: /Exact-file writes cannot be safely executed/, platform: 'linux', plan: plan => { plan.items[0]!.ownedPaths = ['project:/greeting.cjs']; } },
    { name: 'no reviewer independent of the implementer', pattern: /independent of every implementer/ },
  ];
  for (const scenario of scenarios) {
    const f = await fixture(); const engine = new FakeEngine();
    const service = scenario.platform ? new TaskService(f.store, f.service.config, f.dataDir, scenario.platform) : f.service;
    if (scenario.name.startsWith('no reviewer')) {
      const agents = await service.agents('fixture');
      service.agents = async () => agents.map(a => a.id === 'code-reviewer' ? { ...a, enabled: false } : a.id === 'general-developer' ? { ...a, capabilities: [...a.capabilities, 'review'] } : a);
    }
    const execute = engine.execute.bind(engine);
    engine.execute = async request => {
      const result = await execute(request);
      if (request.phase === 'planning' && scenario.plan) { const plan = Plan.parse(result.output); scenario.plan(plan); return { output: plan }; }
      return result;
    };
    const runner = new TaskRunner(service, engine, new FixtureValidator()); service.attachRunner(runner);
    try {
      const task = service.submit({ projectId: 'fixture', request: 'Greeting', mode: 'plan-approval' }, `unexecutable-${scenarios.indexOf(scenario)}`);
      await runner.idle();
      const done = f.store.task(task.id);
      assert.equal(done.state, 'failed', scenario.name);
      assert.match(done.outcome!.error!, scenario.pattern, scenario.name);
      assert.equal(done.plan, undefined, scenario.name);
      const states = f.store.events(task.id).map(e => e.state);
      assert.equal(states.includes('awaiting_plan_approval'), false, scenario.name); assert.equal(states.at(-1), 'failed', scenario.name);
      assert.deepEqual(engine.calls.map(c => c.phase), ['planning'], scenario.name);
      if (scenario.platform === 'linux') assert.match(engine.calls[0]!.prompt, /Linux Codex runtime, ownedPaths must use directory subtree grants/);
    } finally { await runner.stop(); await f.cleanup(); }
  }
});

test('implementation cannot create, modify or hide files that review and the commit would not include', async () => {
  type Scenario = { name: string; implement?: (cwd: string) => Promise<void>; prepare?: (cwd: string) => Promise<void>; expect: 'completed' | RegExp };
  const scenarios: Scenario[] = [
    { name: 'new ignored file used by tests', implement: async cwd => { await writeFile(join(cwd, 'helper.local.cjs'), "module.exports = 'hello';\n"); await writeFile(join(cwd, 'greeting.cjs'), "module.exports = () => require('./helper.local.cjs');\n"); }, expect: /created helper\.local\.cjs/ },
    { name: 'new ignore rule hiding a new file', implement: async cwd => { await writeFile(join(cwd, '.gitignore'), 'node_modules/\n*.local.cjs\nhidden.cjs\n'); await writeFile(join(cwd, 'hidden.cjs'), 'module.exports = 1;\n'); }, expect: /created hidden\.cjs/ },
    { name: 'existing dependency left untouched', prepare: async cwd => { await mkdir(join(cwd, 'node_modules', 'dep'), { recursive: true }); await writeFile(join(cwd, 'node_modules', 'dep', 'index.cjs'), 'module.exports = 1;\n'); }, expect: 'completed' },
    { name: 'existing dependency modified', prepare: async cwd => { await mkdir(join(cwd, 'node_modules', 'dep'), { recursive: true }); await writeFile(join(cwd, 'node_modules', 'dep', 'index.cjs'), 'module.exports = 1;\n'); }, implement: async cwd => { await writeFile(join(cwd, 'node_modules', 'dep', 'index.cjs'), 'module.exports = 2;\n'); }, expect: /modified node_modules\/dep\/index\.cjs/ },
    { name: 'existing dependency removed', prepare: async cwd => { await mkdir(join(cwd, 'node_modules', 'dep'), { recursive: true }); await writeFile(join(cwd, 'node_modules', 'dep', 'index.cjs'), 'module.exports = 1;\n'); }, implement: async cwd => { await rm(join(cwd, 'node_modules', 'dep', 'index.cjs')); }, expect: /removed node_modules\/dep\/index\.cjs/ },
  ];
  for (const scenario of scenarios) {
    const f = await fixture(); const engine = new FakeEngine();
    await writeFile(join(f.project, '.gitignore'), 'node_modules/\n*.local.cjs\n');
    await git(f.project, ['add', '.gitignore']); await git(f.project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Ignore rules']);
    const execute = engine.execute.bind(engine);
    engine.execute = async request => {
      // The task worktree exists from planning onwards; dependencies installed there precede implementation.
      if (request.phase === 'planning' && scenario.prepare) await scenario.prepare(request.cwd);
      const result = await execute(request);
      if (request.phase === 'implementation' && scenario.implement) await scenario.implement(request.cwd);
      return result;
    };
    const runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
    try {
      const task = f.service.submit({ projectId: 'fixture', request: 'Greeting', mode: 'autonomous' }, 'hidden-files');
      await runner.idle(); const done = f.store.task(task.id);
      if (scenario.expect === 'completed') {
        assert.equal(done.state, 'completed', `${scenario.name}: ${JSON.stringify(done.outcome)}`);
      } else {
        assert.equal(done.state, 'failed', scenario.name);
        assert.match(done.outcome!.error!, scenario.expect, scenario.name);
        assert.match(done.outcome!.error!, /review and the commit would not include/, scenario.name);
        assert.deepEqual(engine.calls.map(c => c.phase), ['planning', 'implementation'], scenario.name);
        assert.equal(f.store.evidence(task.id).some(e => e.kind === 'validation' || e.kind === 'commit-created'), false, scenario.name);
      }
    } finally { await runner.stop(); await f.cleanup(); }
  }
});

test('service shutdown records interrupted execution as failed with a shutdown reason, not as a cancellation', async () => {
  const f = await fixture(); const engine = new FakeEngine({ waitForCancel: true });
  const runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
  let reopened: Store | undefined;
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Greeting', mode: 'autonomous' }, 'shutdown');
    const deadline = Date.now() + 10000;
    while (!engine.calls.some(c => c.phase === 'implementation')) { if (Date.now() > deadline) throw new Error('Worker did not start'); await new Promise(r => setTimeout(r, 10)); }
    await runner.stop();
    const done = f.store.task(task.id);
    assert.equal(done.state, 'failed'); assert.match(done.outcome!.error!, /Service shutdown interrupted execution/);
    const last = f.store.events(task.id).at(-1)!;
    assert.equal(last.state, 'failed'); assert.equal(last.actor, 'orchestrator'); assert.match(last.reason, /Service shutdown interrupted execution/);
    assert.equal(f.store.events(task.id).some(e => e.state === 'cancelled'), false);
    reopened = new Store(join(f.dataDir, 'test.db'));
    assert.deepEqual(reopened.recover(), []); assert.equal(reopened.task(task.id).state, 'failed');
  } finally { reopened?.close(); await runner.stop(); await f.cleanup(); }
});
