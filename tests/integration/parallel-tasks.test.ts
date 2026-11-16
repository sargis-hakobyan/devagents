import test from 'node:test';
import assert from 'node:assert/strict';
import { basename, join } from 'node:path';
import { writeFile, access, mkdir } from 'node:fs/promises';
import { fixture } from '../helpers.js';
import { FakeEngine, FixtureValidator } from '../fixtures/fake-engine.js';
import { TaskRunner } from '../../src/orchestration/runner.js';
import { git } from '../../src/workspace/git.js';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
test('two top-level tasks overlap with isolated budgets/evidence, while a third waits for capacity', { timeout: 30000 }, async () => {
  const f = await fixture(); f.service.config.maxConcurrentTasks = 2;
  const engine = new FakeEngine(); const execute = engine.execute.bind(engine);
  const barriers = new Map<string, { started: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }>();
  const attempts = new Map<string, number>(); let brokenId = '';
  engine.execute = async request => {
    const id = basename(request.cwd); const gate = barriers.get(id);
    if (request.phase === 'implementation') {
      gate?.started.resolve(); await gate?.release.promise;
      const result = await execute(request); const attempt = (attempts.get(id) ?? 0) + 1; attempts.set(id, attempt);
      if (id === brokenId && attempt === 1) await writeFile(join(request.cwd, 'greeting.cjs'), "module.exports=()=> 'broken';\n");
      await writeFile(join(request.cwd, 'task-marker.txt'), id);
      return { ...result, output: { ...result.output as object, limitations: [`Fixture limitation ${id}`] } };
    }
    return execute(request);
  };
  const runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
  const before = await git(f.project, ['rev-parse', 'HEAD']);
  try {
    const tasks = ['A', 'B', 'C'].map(name => {
      const task = f.service.submit({ projectId: 'fixture', request: `Task ${name}`, mode: 'autonomous' }, name);
      barriers.set(task.id, { started: deferred(), release: deferred() }); return task;
    });
    brokenId = tasks[0]!.id;
    await Promise.all(tasks.slice(0, 2).map(t => barriers.get(t.id)!.started.promise));
    assert.equal(engine.calls.some(c => c.cwd.endsWith(tasks[2]!.id)), false, 'third task has not entered planning');
    assert.equal(f.store.task(tasks[0]!.id).state, 'running');
    assert.equal(f.store.task(tasks[1]!.id).state, 'running');
    barriers.get(tasks[0]!.id)!.release.resolve();
    await barriers.get(tasks[2]!.id)!.started.promise;
    assert.equal(f.store.task(tasks[1]!.id).state, 'running', 'second task remains independently active');
    for (const gate of barriers.values()) gate.release.resolve();
    await runner.idle();
    for (const task of tasks) {
      const done = f.store.task(task.id); assert.equal(done.state, 'completed', done.outcome?.error);
      assert.deepEqual(done.outcome?.limitations, [`Fixture limitation ${task.id}`]);
      assert.equal(done.outcome?.repairCycles, task.id === brokenId ? 1 : 0);
      assert.equal(await git(f.project, ['show', `${done.workspace!.branch}:task-marker.txt`]), task.id);
      assert.equal(f.store.evidence(task.id).filter(e => e.kind === 'commit-created').length, 1);
    }
    assert.equal(await git(f.project, ['rev-parse', 'HEAD']), before);
    assert.equal(await git(f.project, ['status', '--porcelain']), '');
  } finally { for (const gate of barriers.values()) gate.release.resolve(); await runner.stop(); await f.cleanup(); }
});

test('cancellation drains only its task and cleanup preserves a concurrently active worktree', { timeout: 30000 }, async () => {
  const f = await fixture(); f.service.config.maxConcurrentTasks = 2; f.service.config.cleanupTerminalTasks = true;
  const engine = new FakeEngine(); const execute = engine.execute.bind(engine);
  const gates = new Map<string, { started: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }>();
  const cleaned = deferred(); let sibling = '';
  const cleanup = f.service.cleanupTerminalTask.bind(f.service);
  f.service.cleanupTerminalTask = async id => { await cleanup(id); if (id === sibling) cleaned.resolve(); };
  engine.execute = async request => {
    if (request.phase !== 'implementation') return execute(request);
    const result = await execute(request); const gate = gates.get(basename(request.cwd))!;
    gate.started.resolve(); await gate.release.promise; request.signal.throwIfAborted(); return result;
  };
  const runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
  try {
    const tasks = ['Cancel A', 'Keep B', 'Queued C'].map(request => {
      const task = f.service.submit({ projectId: 'fixture', request, mode: 'autonomous' }, request);
      gates.set(task.id, { started: deferred(), release: deferred() }); return task;
    });
    sibling = tasks[1]!.id;
    await Promise.all(tasks.slice(0, 2).map(t => gates.get(t.id)!.started.promise));
    f.service.cancel(tasks[2]!.id); f.service.cancel(tasks[0]!.id);
    assert.equal(runner.isDrained(tasks[0]!.id), false);
    await assert.rejects(f.service.compactionPreview(tasks[0]!.id), /draining/);
    gates.get(sibling)!.release.resolve(); await cleaned.promise;
    assert.equal(f.store.task(sibling).state, 'completed');
    const heldPath = f.store.task(tasks[0]!.id).workspace!.path;
    await access(heldPath);
    assert.equal(runner.taskScheduling(tasks[0]!.id).status, 'draining');
    gates.get(tasks[0]!.id)!.release.resolve(); await runner.idle();
    assert.equal(f.store.task(tasks[0]!.id).state, 'cancelled');
    assert.equal(f.store.task(tasks[0]!.id).outcome?.commit, undefined);
    assert.equal(engine.calls.some(c => c.cwd.endsWith(tasks[2]!.id)), false);
    assert.ok(f.store.evidence(tasks[0]!.id).some(e => e.kind === 'worktree-cleanup' && (e.data as { recoveryPath?: string }).recoveryPath));
    await assert.rejects(access(heldPath), { code: 'ENOENT' });
    assert.ok(await git(f.project, ['rev-parse', f.store.task(sibling).workspace!.branch]));
  } finally { for (const gate of gates.values()) gate.release.resolve(); await runner.stop(); await f.cleanup(); }
});

test('an approval wait releases task capacity and resumes once after other work completes', { timeout: 30000 }, async () => {
  const f = await fixture(); const engine = new FakeEngine();
  const runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
  try {
    const a = f.service.submit({ projectId: 'fixture', request: 'Needs approval', mode: 'plan-approval' }, 'wait');
    const b = f.service.submit({ projectId: 'fixture', request: 'Independent', mode: 'autonomous' }, 'independent');
    await runner.idle();
    assert.equal(f.store.task(a.id).state, 'awaiting_plan_approval'); assert.equal(f.store.task(b.id).state, 'completed');
    f.service.approve(a.id, f.store.task(a.id).version);
    for (let i = 0; i < 20; i++) runner.enqueue(a.id);
    await runner.idle();
    assert.equal(f.store.task(a.id).state, 'completed');
    assert.equal(engine.calls.filter(c => c.cwd.endsWith(a.id) && c.phase === 'planning').length, 1);
    assert.equal(f.store.evidence(a.id).filter(e => e.kind === 'commit-created').length, 1);
  } finally { await runner.stop(); await f.cleanup(); }
});

test('two DAG tasks share global capacity and keep their item and integration evidence separate', { timeout: 30000 }, async () => {
  const f = await fixture(false); f.service.config.maxConcurrentTasks = 2;
  const engine = new FakeEngine(); const execute = engine.execute.bind(engine); const gates = new Map<string, ReturnType<typeof deferred>>();
  const both = deferred(); const release = deferred(); let running = 0; let peak = 0;
  engine.execute = async request => {
    running++; peak = Math.max(peak, running);
    try {
      if (request.phase === 'planning') {
        const branch = await git(request.cwd, ['branch', '--show-current']);
        return { output: { summary: 'Two isolated modules', risks: [], items: ['one', 'two'].map(id => ({
          id, title: id, description: id, acceptanceCriteria: ['Module works'], dependsOn: [], requiredCapabilities: ['implementation'],
          projectId: 'fixture', branch: `${branch}-${id}`, assignedAgent: 'general-developer', ownedPaths: [`project:/${id}/**`],
          validation: [{ executable: 'node', args: ['--test', `${id}/test.cjs`] }],
        })), integration: { assignedAgent: 'general-developer', validation: [{ executable: 'node', args: ['--test', 'one/test.cjs', 'two/test.cjs'] }] } } };
      }
      if (request.phase === 'implementation') {
        const id = basename(request.cwd).slice(0, 36);
        if (!gates.has(id)) { gates.set(id, deferred()); if (gates.size === 2) both.resolve(); await release.promise; }
        const item = request.workItemId!; await mkdir(join(request.cwd, item), { recursive: true });
        await writeFile(join(request.cwd, item, 'test.cjs'), "require('node:test')('module',()=>require('node:assert/strict').equal(2+2,4));\n");
        return { output: { summary: `Implemented ${item}`, limitations: [] } };
      }
      return execute(request);
    } finally { running--; }
  };
  const runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
  try {
    const tasks = ['DAG A', 'DAG B'].map(request => f.service.submit({ projectId: 'fixture', request, mode: 'autonomous' }, request));
    await both.promise; assert.equal(peak, 2); release.resolve(); await runner.idle();
    for (const task of tasks) {
      const done = f.store.task(task.id); assert.equal(done.state, 'completed', done.outcome?.error);
      assert.equal(f.store.workItems(task.id).filter(i => i.state === 'completed').length, 2);
      assert.equal(f.store.evidence(task.id).filter(e => e.kind === 'commit-created').length, 1);
    }
    assert.equal(peak, 2);
  } finally { release.resolve(); await runner.stop(); await f.cleanup(); }
});

test('raising task capacity starts queued work and lowering it drains without cancelling active tasks', { timeout: 30000 }, async () => {
  const f = await fixture(); const engine = new FakeEngine(); const execute = engine.execute.bind(engine);
  const gates = new Map<string, { started: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }>();
  engine.execute = async request => {
    if (request.phase === 'implementation') {
      const gate = gates.get(basename(request.cwd))!; gate.started.resolve(); await gate.release.promise;
    }
    return execute(request);
  };
  const runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
  try {
    const tasks = ['A', 'B', 'C'].map(request => {
      const task = f.service.submit({ projectId: 'fixture', request, mode: 'autonomous' }, request);
      gates.set(task.id, { started: deferred(), release: deferred() }); return task;
    });
    await gates.get(tasks[0]!.id)!.started.promise;
    assert.equal(runner.scheduling.active.length, 1);
    f.service.setTaskConcurrency({ maxConcurrentTasks: 2, expectedVersion: 0 });
    await gates.get(tasks[1]!.id)!.started.promise;
    assert.equal(runner.scheduling.active.length, 2);
    f.service.setTaskConcurrency({ maxConcurrentTasks: 1, expectedVersion: 1 });
    gates.get(tasks[0]!.id)!.release.resolve();
    for (let i = 0; i < 200 && runner.scheduling.active.length > 1; i++) await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(runner.scheduling.active, [tasks[1]!.id]);
    assert.equal(engine.calls.some(c => c.cwd.endsWith(tasks[2]!.id)), false);
    gates.get(tasks[1]!.id)!.release.resolve(); await gates.get(tasks[2]!.id)!.started.promise;
    gates.get(tasks[2]!.id)!.release.resolve(); await runner.idle();
    for (const task of tasks) assert.equal(f.store.task(task.id).state, 'completed');
  } finally { for (const gate of gates.values()) gate.release.resolve(); await runner.stop(); await f.cleanup(); }
});
