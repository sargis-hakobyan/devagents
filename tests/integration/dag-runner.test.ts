import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture } from '../helpers.js';
import { FixtureValidator } from '../fixtures/fake-engine.js';
import { TaskRunner } from '../../src/orchestration/runner.js';
import { git } from '../../src/workspace/git.js';
import type { CodingEngine, EngineRequest, EngineResult } from '../../src/domain/engine.js';

type Options = { hidden?: boolean; markdown?: boolean; unresolved?: 'markers' | 'separator'; invalidCombinedCommand?: boolean; conflict?: boolean; rejectCombined?: boolean; failItem?: boolean; wait?: boolean; outside?: boolean; diverge?: boolean; roleConcurrency?: number };
async function dagFixture(options: Options = {}) {
  const f = await fixture();
  // Modules live in per-item directories so ownership uses subtree grants, the only write-grant form the Linux runtime accepts.
  for (const id of ['a', 'b', 'c']) {
    const assertion = options.conflict && id !== 'c'
      ? `assert.ok(require('./shared/shared.cjs')().includes('${id}'));`
      : `assert.equal(require('./${id}/${id}.cjs')(),'${id === 'c' ? 'ab' : id}');`;
    await writeFile(join(f.project, `${id}.test.cjs`), `const test=require('node:test'),assert=require('node:assert/strict');test('${id}',()=>{${assertion}});\n`);
    await mkdir(join(f.project, id)); await writeFile(join(f.project, id, `${id}.cjs`), "module.exports=()=> 'broken';\n");
  }
  if (options.conflict) { await mkdir(join(f.project, 'shared')); await writeFile(join(f.project, 'shared', 'shared.cjs'), "module.exports=()=> 'base';\n"); }
  // A Markdown file with a setext heading underline that both conflicting items edit.
  if (options.markdown) await writeFile(join(f.project, 'shared', 'NOTES.md'), 'Notes\n=======\nbase\n');
  await writeFile(join(f.project, '.gitignore'), '*.local.cjs\n');
  await git(f.project, ['add', '.']); await git(f.project, ['commit', '-m', 'Fixture tests']);
  const originalHead = await git(f.project, ['rev-parse', 'HEAD']);
  await mkdir(join(f.dataDir, 'agents'), { recursive: true });
  await writeFile(join(f.dataDir, 'agents', 'module-developer.md'), 'Implement only the assigned module.');
  await writeFile(join(f.dataDir, 'agents', 'module-developer.yaml'), `schemaVersion: 1\nid: module-developer\nname: Module developer\ndescription: Custom module specialist\ncapabilities: [implementation, filesystem-read, filesystem-write]\ninstructionsFile: ./module-developer.md\ndelegation: {canReceiveTasks: true, canDelegate: false}\npermissions:\n  readPaths: ["project:/**"]\n  writePaths: ["project:/a/**", "project:/b/**", "project:/c/**", "project:/shared/**"]\n  allowCommands: true\nconcurrency: ${options.roleConcurrency ?? 2}\n`);
  let active = 0; let maxActive = 0; let reviewActive = 0; let maxReviewActive = 0; let aborted = 0; let combinedReviews = 0;
  let release!: () => void; const twoRunning = new Promise<void>(r => { release = r; });
  const calls: EngineRequest[] = [];
  const engine: CodingEngine = {
    id: 'codex', async preflight() {},
    async execute(r): Promise<EngineResult> {
      calls.push(r);
      if (r.phase === 'planning') {
        const branch = await git(r.cwd, ['branch', '--show-current']);
        return { output: { summary: 'Build two modules and combine them', risks: [], integration: { assignedAgent: 'general-developer', validation: [{ executable: 'node', args: ['--test', 'a.test.cjs', 'b.test.cjs', 'c.test.cjs'] }, ...(options.invalidCombinedCommand ? [{ executable: 'node', args: ['-e', 'throw new Error("Must not execute")'] }] : [])] }, items: ['a', 'b', 'c'].map(id => ({
          id, title: `Module ${id}`, description: `Implement ${id}`, acceptanceCriteria: ['Existing test passes'], dependsOn: id === 'c' ? ['a', 'b'] : [], requiredCapabilities: ['implementation'], assignedAgent: 'module-developer', projectId: 'fixture', branch: `${branch}-${id}`, ownedPaths: [`project:/${options.conflict && id !== 'c' ? 'shared' : id}/**`], validation: [{ executable: 'node', args: ['--test', `${id}.test.cjs`] }],
        })) } };
      }
      if (r.phase === 'review') {
        reviewActive++; maxReviewActive = Math.max(maxReviewActive, reviewActive);
        try {
          await delay(25, undefined, { signal: r.signal });
          if (r.workItemId === '@integration') {
            combinedReviews++;
            if (options.diverge) { await writeFile(join(f.project, 'new.txt'), 'External change'); await git(f.project, ['add', '.']); await git(f.project, ['commit', '-m', 'User change']); }
            if (options.rejectCombined && combinedReviews === 1) return { output: { approved: false, summary: 'Repair requested', findings: ['Clarify implementation'] } };
          }
          return { output: { approved: true, summary: 'Tests and requirements satisfied', findings: [] } };
        } finally { reviewActive--; }
      }
      if (r.workItemId === '@integration') {
        if (options.conflict) await writeFile(join(r.cwd, 'shared', 'shared.cjs'), "module.exports=()=> 'ab';\n");
        if (options.markdown) await writeFile(join(r.cwd, 'shared', 'NOTES.md'), options.unresolved === 'markers' ? 'Notes\n=======\n<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\n' : options.unresolved === 'separator' ? 'Notes\n=======\na\n=======\nb\n' : 'Notes\n=======\nab\n');
        return { output: { summary: 'Resolved integration' } };
      }
      active++; maxActive = Math.max(maxActive, active); if (active === 2) release();
      try {
        if (options.wait || options.failItem) {
          await Promise.race([twoRunning, delay(5000, undefined, { signal: r.signal }).then(() => { throw new Error('Concurrent workers did not start'); })]);
          if (options.failItem && r.workItemId === 'a') throw new Error('Intentional item failure');
          try { await delay(30000, undefined, { signal: r.signal }); } catch (error) { aborted++; throw error; }
        } else await delay(150, undefined, { signal: r.signal });
        const id = r.workItemId!;
        if (options.outside && id === 'a') await writeFile(join(r.cwd, 'README.md'), 'Out of owned scope');
        if (options.hidden && id === 'a') await writeFile(join(r.cwd, 'a', 'a.local.cjs'), 'module.exports = 1;\n');
        if (id === 'c') {
          if (options.conflict) assert.match(await readFile(join(r.cwd, 'shared', 'shared.cjs'), 'utf8'), /ab/);
          else { assert.match(await readFile(join(r.cwd, 'a', 'a.cjs'), 'utf8'), /'a'/); assert.match(await readFile(join(r.cwd, 'b', 'b.cjs'), 'utf8'), /'b'/); }
        }
        const module = options.conflict && id !== 'c' ? 'shared' : id;
        await writeFile(join(r.cwd, module, `${module}.cjs`), `module.exports=()=> '${id === 'c' ? 'ab' : id}';\n`);
        if (options.markdown && id !== 'c') await writeFile(join(r.cwd, 'shared', 'NOTES.md'), `Notes\n=======\n${id}\n`);
        return { output: { summary: `Implemented ${id}` } };
      } finally { active--; }
    },
  };
  const runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
  return { ...f, runner, calls, originalHead, twoRunning, metrics: () => ({ active, maxActive, maxReviewActive, aborted, combinedReviews }), options };
}

test('DAG runs parallel config-only specialists, integrates dependencies, reviews combined changes, and preserves dirty checkout', async () => {
  const f = await dagFixture();
  try {
    await writeFile(join(f.project, 'README.md'), 'Uncommitted user work');
    const task = f.service.submit({ projectId: 'fixture', request: 'Three modules', mode: 'autonomous' }, 'dag');
    await f.runner.idle(); const done = f.store.task(task.id);
    assert.equal(done.state, 'completed', JSON.stringify(done.outcome));
    assert.equal(f.metrics().maxActive, 2); assert.equal(f.metrics().maxReviewActive, 1);
    assert.equal(new Set(f.calls.filter(c => c.phase === 'implementation').map(c => c.cwd)).size, 3);
    for (const call of f.calls.filter(c => c.phase === 'implementation')) assert.deepEqual(call.agent.permissions.writePaths, [`project:/${call.workItemId}/**`], call.workItemId);
    assert.equal(await readFile(join(f.project, 'README.md'), 'utf8'), 'Uncommitted user work');
    assert.equal(await git(f.project, ['rev-parse', 'HEAD']), f.originalHead);
    assert.equal(await git(done.workspace!.path, ['status', '--porcelain']), '');
    assert.equal(f.store.workItems(task.id).every(i => i.state === 'completed'), true);
    assert.equal(f.store.evidence(task.id).filter(e => e.kind === 'item-commit-created').length, 3);
    assert.equal(f.store.evidence(task.id).filter(e => e.kind === 'commit-created').length, 1);
    const itemReviews = f.calls.filter(c => c.phase === 'review' && c.workItemId !== '@integration');
    assert.equal(itemReviews.length, 3);
    for (const review of itemReviews) {
      assert.match(review.prompt, /ITEM INTEGRATION GATE/);
      assert.match(review.prompt, /not task completion/);
      assert.match(review.prompt, /"originalGitStatusUnchanged":true/);
      assert.match(review.prompt, /"originalGitStatusCleanBeforeAndNow":false/);
    }
    const combinedReview = f.calls.find(c => c.phase === 'review' && c.workItemId === '@integration')!;
    assert.match(combinedReview.prompt, /FINAL COMBINED GATE/);
    const combinedValidation = JSON.parse(combinedReview.prompt.split('Actual validation:\n')[1]!);
    assert.ok(combinedValidation.some((v: { args: string[]; exitCode: number }) => v.exitCode === 0 && ['a.test.cjs', 'b.test.cjs', 'c.test.cjs'].every(file => v.args.includes(file))));
  } finally { await f.runner.stop(); await f.cleanup(); }
});
test('DAG plan approval pauses every worker and per-role concurrency is honored', async () => {
  const f = await dagFixture({ roleConcurrency: 1 });
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Three modules', mode: 'plan-approval' }, 'approval');
    await f.runner.idle(); const pending = f.store.task(task.id);
    assert.equal(pending.state, 'awaiting_plan_approval'); assert.equal(f.calls.length, 1);
    f.service.approve(task.id, pending.version); await f.runner.idle();
    assert.equal(f.store.task(task.id).state, 'completed', JSON.stringify(f.store.task(task.id).outcome));
    assert.equal(f.metrics().maxActive, 1);
  } finally { await f.runner.stop(); await f.cleanup(); }
});
test('overlapping edits create an explicit integration repair and dependents see the resolved result', async () => {
  const f = await dagFixture({ conflict: true });
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Combine both edits', mode: 'autonomous' }, 'conflict'); await f.runner.idle();
    const done = f.store.task(task.id); assert.equal(done.state, 'completed', JSON.stringify(done.outcome));
    assert.equal(done.outcome!.repairCycles, 1);
    assert.ok(f.store.evidence(task.id).some(e => e.kind === 'integration-conflict'));
    assert.match(await readFile(join(done.workspace!.path, 'shared', 'shared.cjs'), 'utf8'), /ab/);
  } finally { await f.runner.stop(); await f.cleanup(); }
});
test('combined review rejection triggers bounded integration repair and full revalidation', async () => {
  const f = await dagFixture({ rejectCombined: true });
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Three modules', mode: 'autonomous' }, 'repair'); await f.runner.idle();
    assert.equal(f.store.task(task.id).state, 'completed', JSON.stringify(f.store.task(task.id).outcome));
    assert.equal(f.store.task(task.id).outcome!.repairCycles, 1); assert.equal(f.metrics().combinedReviews, 2);
  } finally { await f.runner.stop(); await f.cleanup(); }
});
test('failed work item aborts siblings, blocks dependents, and prevents the final commit', async () => {
  const f = await dagFixture({ failItem: true });
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Three modules', mode: 'autonomous' }, 'fail'); await f.runner.idle();
    assert.equal(f.store.task(task.id).state, 'failed'); assert.match(f.store.task(task.id).outcome!.error!, /Intentional item failure/);
    assert.equal(f.metrics().active, 0); assert.equal(f.metrics().aborted, 1);
    assert.equal(f.calls.some(c => c.workItemId === 'c'), false);
    const items = Object.fromEntries(f.store.workItems(task.id).map(i => [i.itemId as string, i]));
    assert.equal(items.a!.state, 'failed'); assert.equal(items.c!.state, 'blocked');
    assert.equal(items.b!.state, 'aborted'); assert.match(String(items.b!.reason), /sibling work item failed/);
    assert.equal(f.store.evidence(task.id).some(e => e.kind === 'commit-created'), false);
  } finally { await f.runner.stop(); await f.cleanup(); }
});
test('service shutdown during a wave marks running workers interrupted and unstarted dependents blocked', async () => {
  const f = await dagFixture({ wait: true });
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Three modules', mode: 'autonomous' }, 'shutdown');
    await f.twoRunning; await f.runner.stop();
    const done = f.store.task(task.id);
    assert.equal(done.state, 'failed'); assert.match(done.outcome!.error!, /Service shutdown interrupted execution/);
    assert.equal(f.metrics().active, 0);
    const items = Object.fromEntries(f.store.workItems(task.id).map(i => [i.itemId as string, i]));
    for (const id of ['a', 'b']) { assert.equal(items[id]!.state, 'interrupted', id); assert.match(String(items[id]!.reason), /Service shutdown/, id); }
    assert.equal(items.c!.state, 'blocked'); assert.match(String(items.c!.reason), /Service shutdown/);
    assert.equal(f.store.workItems(task.id).some(i => i.state === 'cancelled'), false);
    assert.equal(f.store.evidence(task.id).some(e => e.kind === 'commit-created'), false);
  } finally { await f.runner.stop(); await f.cleanup(); }
});
test('cancellation drains all concurrent workers and prevents dependency execution', async () => {
  const f = await dagFixture({ wait: true });
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Three modules', mode: 'autonomous' }, 'cancel');
    await f.twoRunning; f.service.cancel(task.id); await f.runner.idle();
    assert.equal(f.store.task(task.id).state, 'cancelled'); assert.equal(f.metrics().active, 0);
    assert.equal(f.store.workItems(task.id).every(i => i.state === 'cancelled'), true);
    assert.equal(f.calls.some(c => c.workItemId === 'c'), false);
  } finally { await f.runner.stop(); await f.cleanup(); }
});
for (const kind of ['outside', 'diverge'] as const) test(`DAG rejects ${kind === 'outside' ? 'changes outside item ownership' : 'original HEAD divergence'} before final commit`, async () => {
  const f = await dagFixture({ [kind]: true });
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Three modules', mode: 'autonomous' }, kind); await f.runner.idle();
    const done = f.store.task(task.id); assert.equal(done.state, 'failed');
    assert.match(done.outcome!.error!, kind === 'outside' ? /cannot write/ : /Original project HEAD changed/);
    assert.equal(f.store.evidence(task.id).some(e => e.kind === 'commit-created'), false);
  } finally { await f.runner.stop(); await f.cleanup(); }
});

test('conflict budget exhaustion preserves worktrees and never creates a final task commit', async () => {
  const f = await dagFixture({ conflict: true }); f.service.config.maxRepairCycles = 0;
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Combine edits', mode: 'autonomous' }, 'no-repair'); await f.runner.idle();
    assert.equal(f.store.task(task.id).state, 'failed'); assert.match(f.store.task(task.id).outcome!.error!, /Integration conflict/);
    assert.equal(f.store.evidence(task.id).some(e => e.kind === 'commit-created'), false);
    assert.equal(f.calls.some(c => c.workItemId === 'c'), false);
  } finally { await f.runner.stop(); await f.cleanup(); }
});
test('configured custom merge drivers are rejected before any worker runs', async () => {
  const f = await dagFixture();
  try {
    await git(f.project, ['config', 'merge.unsafe.driver', 'false']);
    const task = f.service.submit({ projectId: 'fixture', request: 'Three modules', mode: 'autonomous' }, 'driver'); await f.runner.idle();
    assert.equal(f.store.task(task.id).state, 'failed'); assert.match(f.store.task(task.id).outcome!.error!, /merge drivers/);
    assert.equal(f.calls.some(c => c.phase === 'implementation'), false);
  } finally { await f.runner.stop(); await f.cleanup(); }
});


test('unsupported combined validation is rejected before any worker starts', async () => {
  const f = await dagFixture({ invalidCombinedCommand: true });
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Three modules', mode: 'autonomous' }, 'unsupported-validation');
    await f.runner.idle();
    assert.equal(f.store.task(task.id).state, 'failed');
    assert.match(f.store.task(task.id).outcome!.error!, /Validation supports/);
    assert.equal(f.store.task(task.id).plan, undefined);
    assert.deepEqual(f.calls.map(call => call.phase), ['planning']);
    assert.equal(f.store.evidence(task.id).some(e => e.kind === 'commit-created'), false);
  } finally { await f.runner.stop(); await f.cleanup(); }
});

test('a worker that writes an ignored file inside its owned directory fails before validation and review', async () => {
  const f = await dagFixture({ hidden: true });
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Three modules', mode: 'autonomous' }, 'hidden'); await f.runner.idle();
    const done = f.store.task(task.id); assert.equal(done.state, 'failed');
    assert.match(done.outcome!.error!, /Work item a changed 1 file\(s\) that review and the commit would not include.*created a\/a\.local\.cjs/);
    assert.equal(f.store.workItems(task.id).find(i => i.itemId === 'a')!.state, 'failed');
    assert.equal(f.calls.some(c => c.phase === 'review' && c.workItemId === 'a'), false);
    assert.equal(f.store.evidence(task.id).some(e => e.kind === 'commit-created'), false);
  } finally { await f.runner.stop(); await f.cleanup(); }
});

test('a conflicting Markdown file keeps its heading underline after repair and the task completes', async () => {
  const f = await dagFixture({ conflict: true, markdown: true });
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Combine notes', mode: 'autonomous' }, 'markdown-conflict'); await f.runner.idle();
    const done = f.store.task(task.id); assert.equal(done.state, 'completed', JSON.stringify(done.outcome));
    const conflict = f.store.evidence(task.id).find(e => e.kind === 'integration-conflict')!.data as { files: string[] };
    assert.ok(conflict.files.includes('shared/NOTES.md'));
    assert.equal(f.store.evidence(task.id).some(e => e.kind === 'integration-unresolved'), false);
    assert.equal(await readFile(join(done.workspace!.path, 'shared', 'NOTES.md'), 'utf8'), 'Notes\n=======\nab\n');
    assert.ok(done.outcome!.files!.includes('shared/NOTES.md'));
  } finally { await f.runner.stop(); await f.cleanup(); }
});
for (const unresolved of ['markers', 'separator'] as const) test(`a repair that leaves ${unresolved === 'markers' ? 'conflict markers' : 'an extra conflict separator'} is not accepted as resolved`, async () => {
  const f = await dagFixture({ conflict: true, markdown: true, unresolved });
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Combine notes', mode: 'autonomous' }, `unresolved-${unresolved}`); await f.runner.idle();
    const done = f.store.task(task.id); assert.equal(done.state, 'failed');
    assert.match(done.outcome!.error!, /Integration conflict exhausted the repair budget/);
    const problems = f.store.evidence(task.id).filter(e => e.kind === 'integration-unresolved').map(e => e.data as { file: string; problem: string });
    assert.ok(problems.length >= 1);
    assert.equal(problems[0]!.file, 'shared/NOTES.md');
    assert.match(problems[0]!.problem, unresolved === 'markers' ? /^conflict marker$/ : /conflict separator \(2 "=======" lines, at most 1/);
    assert.equal(f.store.evidence(task.id).some(e => e.kind === 'integration-resolved' || e.kind === 'commit-created'), false);
    assert.equal(f.calls.some(c => c.workItemId === 'c'), false);
  } finally { await f.runner.stop(); await f.cleanup(); }
});
test('cleanup of a completed DAG task removes every item worktree and item branch but keeps the task branch', async () => {
  const f = await dagFixture();
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Three modules', mode: 'autonomous' }, 'dag-cleanup'); await f.runner.idle();
    const done = f.store.task(task.id); assert.equal(done.state, 'completed', JSON.stringify(done.outcome));
    const before = (await git(f.project, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'])).split('\n').filter(Boolean);
    assert.equal(before.filter(b => b.startsWith(`codex/devagents-${task.id}-`)).length, 3);
    const result = await f.service.cleanup(task.id);
    assert.equal(result.removedWorktrees.length, 4); assert.equal(result.removedBranches.length, 3); assert.deepEqual(result.keptBranches, [done.workspace!.branch]);
    const after = (await git(f.project, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'])).split('\n').filter(Boolean).sort();
    assert.deepEqual(after, [done.workspace!.branch, 'main']);
    assert.equal((await git(f.project, ['worktree', 'list', '--porcelain'], false)).split('\n').filter(l => l.startsWith('worktree ')).length, 1);
    assert.equal(await git(f.project, ['rev-parse', done.workspace!.branch]), done.outcome!.commit);
  } finally { await f.runner.stop(); await f.cleanup(); }
});
