import test from 'node:test';
import assert from 'node:assert/strict';
import { basename, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
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
