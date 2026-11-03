import test from 'node:test';
import assert from 'node:assert/strict';
import { fold, teamBoard, duration, itemStatus, type BoardInput, type BoardStatus } from '../../ui/src/team-board.js';

const T0 = Date.parse('2026-11-02T09:41:03Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const agent = (id: string, name: string, capabilities: string[], canDelegate = false) => ({ id, name, capabilities, enabled: true, delegation: { canDelegate } });
const roster = [agent('tech-lead', 'Tech Lead', ['planning', 'filesystem-read'], true), agent('backend-developer', 'Backend Developer', ['implementation', 'backend']), agent('frontend-developer', 'Frontend Developer', ['implementation', 'frontend']), agent('general-developer', 'Developer', ['implementation']), agent('qa-engineer', 'QA Engineer', ['testing']), agent('code-reviewer', 'Code Reviewer', ['review'])];
const cmd = (s: string) => { const [executable, ...args] = s.split(' '); return { executable: executable!, args }; };
const item = (id: string, assignedAgent: string, dependsOn: string[] = []) => ({ id, title: `Module ${id}`, assignedAgent, requiredCapabilities: ['implementation'], validation: [cmd(`node --test ${id}.test.cjs`)], ownedPaths: [`project:/${id}/**`], dependsOn });
const multiPlan = { items: [item('a', 'backend-developer'), item('b', 'frontend-developer'), item('c', 'general-developer', ['a', 'b'])], integration: { assignedAgent: 'general-developer', validation: [cmd('node --test a.test.cjs b.test.cjs c.test.cjs')] } };
type Ev = BoardInput['evidence'][number];
const ev = (kind: string, s: number, data: Record<string, unknown>): Ev => ({ kind, at: at(s), data });
const run = (runId: string, phase: string, agentId: string, start: number, end?: number, extra: Record<string, unknown> = {}, output?: unknown): Ev[] => [ev('run-started', start, { runId, phase, agentId, ...extra }), ...(end === undefined ? [] : [ev('run-completed', end, { runId, phase, ...extra, ...(output === undefined ? {} : { output }) })])];
const approved = { approved: true, summary: 'ok', findings: [] };
const base = (over: Partial<BoardInput['task']> = {}): BoardInput['task'] => ({ id: 't1', state: 'running', version: 7, createdAt: at(0), updatedAt: at(400), approval: { status: 'autonomous' }, plan: multiPlan, agents: roster, workspace: { branch: 'devagents/three-modules-12b1ca2d' }, ...over });
const board = (task: BoardInput['task'], items: BoardInput['items'], evidence: Ev[], now = T0 + 500_000) => teamBoard({ task, items, evidence, now });
const stage = (b: ReturnType<typeof teamBoard>, key: string) => b.stages.find(s => s.key === key)!;
const member = (b: ReturnType<typeof teamBoard>, key: string, id: string) => stage(b, key).members.find(m => m.id === id)!;

const multiRunning = () => {
  const evidence: Ev[] = [
    ...run('p', 'planning', 'tech-lead', 0, 41),
    ev('work-item', 47, { itemId: 'a', state: 'creating' }), ev('work-item', 47, { itemId: 'b', state: 'creating' }),
    ...run('ia', 'implementation', 'backend-developer', 50, 150, { workItemId: 'a' }), ev('validation', 160, { workItemId: 'a', exitCode: 0 }), ...run('ra', 'review', 'code-reviewer', 161, 180, { workItemId: 'a' }, approved), ev('item-commit-created', 181, { workItemId: 'a', commit: '9c2e1f0abc' }), ev('work-item', 189, { itemId: 'a', state: 'completed' }),
    ...run('ib', 'implementation', 'frontend-developer', 50, 170, { workItemId: 'b' }), ev('validation', 175, { workItemId: 'b', exitCode: 1 }), ...run('ib2', 'implementation', 'frontend-developer', 176, 230, { workItemId: 'b' }), ev('validation', 240, { workItemId: 'b', exitCode: 0 }), ...run('rb', 'review', 'code-reviewer', 241, 285, { workItemId: 'b' }, approved), ev('item-commit-created', 286, { workItemId: 'b', commit: '41ab9d3def' }), ev('work-item', 299, { itemId: 'b', state: 'completed' }),
    ev('work-item', 300, { itemId: 'c', state: 'creating' }), ...run('ic', 'implementation', 'general-developer', 302, 370, { workItemId: 'c' }), ev('work-item', 371, { itemId: 'c', state: 'validating' }),
  ];
  const items = [{ itemId: 'a', state: 'completed', agentId: 'backend-developer', commit: '9c2e1f0abc', repairCycles: 0 }, { itemId: 'b', state: 'completed', agentId: 'frontend-developer', commit: '41ab9d3def', repairCycles: 1 }, { itemId: 'c', state: 'validating', agentId: 'general-developer', repairCycles: 0 }];
  return { evidence, items };
};

test('a multi-item task in flight: five stages, measured lines, reviewer up next, QA not needed, ordered list', () => {
  const { evidence, items } = multiRunning();
  const b = board(base(), items, evidence);
  assert.deepEqual(b.stages.map(s => `${s.number} ${s.title}`), ['1 Plan', '2 Build', '3 Integrate', '4 Review', '5 Commit']);
  assert.equal(stage(b, 'plan').chip.text, '✓ Done'); assert.deepEqual(member(b, 'plan', 'tech-lead').lines, ['Plan v7 · 3 items · 41 s', 'Approved automatically']);
  assert.equal(stage(b, 'build').chip.text, '▶ 2 of 3 done');
  const backend = member(b, 'build', 'backend-developer'); assert.equal(backend.status, 'done'); assert.equal(backend.name, 'Backend Developer'); assert.equal(backend.durationMs, 100_000);
  assert.match(backend.lines[0]!, /^a · Module a · implemented · tests ✓ · review ✓ · checkpoint 9c2e1f0 · integrated$/);
  const frontend = member(b, 'build', 'frontend-developer'); assert.equal(frontend.items[0]!.chips[1]!.text, 'Tests ✕ then ✓ (2 runs)'); assert.equal(frontend.items[0]!.chips[0]!.text, 'Implemented ×2'); assert.equal(frontend.durationMs, 174_000);
  const dev = member(b, 'build', 'general-developer'); assert.equal(dev.status, 'busy'); assert.equal(dev.lines[0], 'c · Module c · validating · 3 min 20 s', 'elapsed from the recorded start to now');
  const reviewer = member(b, 'review', 'code-reviewer'); assert.equal(reviewer.status, 'next'); assert.deepEqual(reviewer.lines, ['2 ✓ · 0 findings', 'Next: item c, once its tests pass']); assert.equal(stage(b, 'review').chip.text, '2 of 3');
  assert.equal(member(b, 'integrate', 'general-developer').status, 'next'); assert.equal(member(b, 'integrate', 'general-developer').lines[0], 'Combined validation · 4 commands');
  assert.equal(member(b, 'commit', 'devagents').lines[0], 'One local commit on devagents/three-modules-12b1ca2d');
  assert.deepEqual(b.notNeeded.map(m => [m.id, m.reason]), [['qa-engineer', 'not assigned by the plan']]);
  assert.deepEqual(b.list.map(m => `${m.id}:${m.status}`), ['general-developer:busy', 'code-reviewer:next', 'devagents:next', 'tech-lead:done', 'backend-developer:done', 'frontend-developer:done']);
  assert.equal(b.list.find(m => m.id === 'general-developer')!.lines.length, 3, 'the developer card merges its build and integrate lines');
  assert.equal(b.summary, '5 of 6 members involved · 3 finished · 1 working · 1 up next');
});

test('a single-item task without progress rows is synthesized from the task state; four stages, reviewer working', () => {
  const plan = { items: [item('fix', 'general-developer')], integration: null };
  const evidence: Ev[] = [...run('p', 'planning', 'tech-lead', 0, 64), ...run('i', 'implementation', 'general-developer', 70, 190, { workItemId: 'fix' }), ev('validation', 195, { workItemId: 'fix', exitCode: 0 }), ...run('r', 'review', 'code-reviewer', 200, undefined, { workItemId: 'fix' })];
  const b = board(base({ state: 'reviewing', plan, approval: { status: 'approved', timestamp: at(66) } }), [], evidence, T0 + 248_000);
  assert.deepEqual(b.stages.map(s => s.key), ['plan', 'build', 'review', 'commit']); assert.equal(stage(b, 'commit').number, 4);
  assert.equal(member(b, 'plan', 'tech-lead').lines[1]!.slice(0, 12), 'You approved');
  const dev = member(b, 'build', 'general-developer'); assert.equal(dev.status, 'busy'); assert.equal(dev.items[0]!.verb, 'in review'); assert.equal(dev.items[0]!.chips[1]!.text, 'Tests ✓'); assert.equal(dev.items[0]!.chips.length, 3, 'no checkpoint or integration chips for a single item');
  const reviewer = member(b, 'review', 'code-reviewer'); assert.equal(reviewer.status, 'busy'); assert.equal(reviewer.lines[1], 'Now: item fix · 48 s'); assert.equal(stage(b, 'review').chip.text, '▶ Working');
  assert.equal(b.summary, '3 of 6 members involved · 1 finished · 2 working · 0 up next');
});

test('a single-item task attributes item-less runs, validations and reviews to its only item, and reads task-state item rows', () => {
  const plan = { items: [item('fix', 'general-developer')], integration: null };
  const evidence: Ev[] = [...run('i', 'implementation', 'general-developer', 70, 90), ev('validation', 95, { exitCode: 0 }), ...run('r', 'review', 'code-reviewer', 100, 110, {}, { approved: false, summary: 'no', findings: ['Rename it'] }), ...run('i2', 'implementation', 'general-developer', 111, 130), ev('validation', 135, { exitCode: 0 }), ...run('r2', 'review', 'code-reviewer', 140, 150, {}, { approved: false, summary: 'no', findings: ['Still'] })];
  const b = board(base({ state: 'failed', plan, outcome: { error: 'Repair budget exhausted' } }), [{ itemId: 'fix', state: 'failed', agentId: 'general-developer' }], evidence);
  const dev = member(b, 'build', 'general-developer'); assert.deepEqual(dev.items[0]!.chips.map(c => c.text), ['Implemented ×2', 'Tests ✓', 'Review · 1 finding']); assert.equal(dev.items[0]!.error, 'Repair budget exhausted');
  assert.equal(member(b, 'review', 'code-reviewer').lines[0], '0 ✓ · 1 ✕ · 1 finding');
  const waiting = board(base({ state: 'awaiting_plan_approval', plan, approval: { status: 'awaiting' } }), [{ itemId: 'fix', state: 'awaiting_plan_approval', agentId: 'general-developer' }], []);
  assert.equal(member(waiting, 'build', 'general-developer').items[0]!.verb, 'waiting for your approval'); assert.equal(member(waiting, 'build', 'general-developer').status, 'next');
  assert.equal(itemStatus('committing'), 'done');
});

test('"You" is a member only while a decision is yours, placed before the lead for the mode choice and after it for approval', () => {
  const waiting = board(base({ state: 'awaiting_plan_approval', approval: { status: 'awaiting' } }), [], run('p', 'planning', 'tech-lead', 0, 30));
  assert.deepEqual(stage(waiting, 'plan').members.map(m => m.id), ['tech-lead', 'you']); assert.equal(stage(waiting, 'plan').chip.text, '● Needs you');
  assert.equal(member(waiting, 'plan', 'you').status, 'you'); assert.equal(member(waiting, 'plan', 'you').lines[0], 'Approve plan version 7, or reject it');
  assert.equal(member(waiting, 'build', 'backend-developer').lines[1], 'Starts after your decision'); assert.equal(waiting.list[0]!.id, 'you'); assert.equal(waiting.counts.needsYou, 1);
  const mode = board(base({ state: 'awaiting_mode', plan: undefined, approval: undefined }), [], []);
  assert.deepEqual(stage(mode, 'plan').members.map(m => m.id), ['you', 'tech-lead']); assert.equal(member(mode, 'plan', 'tech-lead').lines[0], 'Plans after you choose a mode');
  assert.equal(stage(mode, 'build').members.length, 0); assert.equal(stage(mode, 'build').chip.text, 'Up next');
  assert.equal(board(base(), [], []).list.some(m => m.id === 'you'), false);
});

test('developer setup and final preflight stay visibly working until implementation starts', () => {
  const task = base({ state: 'ready', plan: { items: [item('fix', 'general-developer')] } });
  const items = [{ itemId: 'fix', state: 'ready', agentId: 'general-developer' }];
  const evidence = [...run('p', 'planning', 'tech-lead', 0, 93), ev('environment', 93, { state: 'installing' }), ...run('s', 'setup', 'general-developer', 93)];
  const setup = board(task, items, evidence, T0 + 130_000);
  const dev = member(setup, 'build', 'general-developer');
  assert.equal(setup.counts.working, 1);
  assert.equal(stage(setup, 'build').chip.text, '▶ Setting up');
  assert.equal(dev.status, 'busy');
  assert.match(dev.lines[0]!, /setting up dependencies and tools · 37 s$/);
  assert.equal(dev.items[0]!.chips[0]!.text, 'Setting up');
  assert.equal(dev.durationMs, 37_000);
  assert.equal(dev.lines.some(l => /slot|Waiting for implementation/.test(l)), false);

  evidence.push(ev('run-completed', 138, { runId: 's', phase: 'setup' }));
  const preflight = board(task, items, evidence, T0 + 142_000);
  assert.equal(preflight.counts.working, 1);
  assert.equal(stage(preflight, 'build').chip.text, '▶ Checking tools');
  assert.match(member(preflight, 'build', 'general-developer').lines[0]!, /checking tools before continuing/);

  evidence.push(ev('environment', 145, { state: 'ready' }), ...run('i', 'implementation', 'general-developer', 145));
  const implementing = board({ ...task, state: 'running' }, [{ ...items[0]!, state: 'running' }], evidence, T0 + 155_000);
  const implementingDev = member(implementing, 'build', 'general-developer');
  assert.equal(implementingDev.items[0]!.verb, 'implementing');
  assert.equal(implementingDev.items[0]!.chips.length, 3);
  assert.equal(implementingDev.durationMs, 55_000, 'setup and implementation run time are both counted');
});

test('setup is scoped to the active work item and cannot reopen stopped or completed tasks', () => {
  const evidence = [ev('environment', 10, { workItemId: 'a', state: 'installing' }), ...run('s', 'setup', 'backend-developer', 10, undefined, { workItemId: 'a' })];
  const items = [{ itemId: 'a', state: 'running', agentId: 'backend-developer' }, { itemId: 'b', state: 'pending', agentId: 'frontend-developer' }];
  const b = board(base(), items, evidence);
  assert.equal(member(b, 'build', 'backend-developer').items[0]!.verb, 'setting up dependencies and tools');
  assert.equal(member(b, 'build', 'frontend-developer').status, 'next');
  for (const state of ['failed', 'cancelled', 'completed']) {
    const stopped = board(base({ state, plan: { items: [item('a', 'backend-developer')] } }), [{ ...items[0]!, state }], evidence);
    assert.equal(stopped.counts.working, 0);
    assert.notEqual(member(stopped, 'build', 'backend-developer').items[0]!.state, 'setup');
  }
});

test('environment-only preparation and setup-run-only evidence both show work without inventing a queue wait', () => {
  const task = base({ state: 'ready', plan: { items: [item('fix', 'general-developer')] } });
  const checking = board(task, [], [ev('environment', 10, { state: 'checking' })]);
  assert.equal(stage(checking, 'build').chip.text, '▶ Checking tools');
  const setup = board(task, [], run('s', 'setup', 'general-developer', 10));
  assert.equal(stage(setup, 'build').chip.text, '▶ Setting up');
  const ready = board(task, [], [...run('s', 'setup', 'general-developer', 10), ev('environment', 20, { state: 'ready' })]);
  assert.equal(stage(ready, 'build').status, 'next', 'readiness supersedes an incomplete run log');
  assert.equal(member(ready, 'build', 'general-developer').lines[1], 'Waiting for implementation to start');
});

test('QA has an explicit stage, counts as working, and never invents verification for historical tasks', () => {
  const task = base({ state: 'validating', plan: { items: [item('fix', 'general-developer')] } });
  const evidence = [ev('qa-assignment', 5, { state: 'assigned', agentId: 'qa-engineer' }), ...run('i', 'implementation', 'general-developer', 10, 20), ev('validation', 21, { exitCode: 0 }), ...run('q', 'qa', 'qa-engineer', 22)];
  const active = board(task, [], evidence, T0 + 30_000);
  assert.deepEqual(active.stages.map(s => s.title), ['Plan', 'Build', 'QA', 'Review', 'Commit']);
  assert.equal(stage(active, 'qa').chip.text, '▶ Verifying');
  assert.equal(active.counts.working, 1);
  assert.match(member(active, 'qa', 'qa-engineer').lines[0]!, /8 s/);
  assert.equal(active.notNeeded.some(m => m.id === 'qa-engineer'), false);

  evidence.push(ev('run-completed', 32, { runId: 'q', phase: 'qa' }), ev('qa-result', 33, { state: 'passed', summary: 'All criteria verified' }));
  const passed = board({ ...task, state: 'reviewing' }, [], evidence);
  assert.equal(stage(passed, 'qa').status, 'done');
  const repaired = board({ ...task, state: 'running' }, [], [...evidence, ...run('i2', 'implementation', 'general-developer', 40)]);
  assert.equal(stage(repaired, 'qa').status, 'next', 'changed implementation requires fresh QA');
  const blockedEvidence = [...evidence.slice(0, -1), ev('qa-result', 33, { state: 'blocked', summary: 'Browser unavailable' })];
  const blocked = board({ ...task, state: 'failed' }, [{ itemId: 'fix', state: 'failed', agentId: 'general-developer' }], blockedEvidence);
  assert.equal(stage(blocked, 'qa').chip.text, 'Blocked');
  assert.equal(stage(blocked, 'qa').status, 'blocked');
  assert.equal(member(blocked, 'build', 'general-developer').status, 'done');
  assert.equal(member(blocked, 'build', 'general-developer').items[0]!.state, 'implemented');
  assert.equal(blocked.counts.failed, 0); assert.equal(blocked.counts.blocked, 1);
  assert.equal(stage(blocked, 'commit').status, 'aborted');
  const multiplePassingChecks = board({ ...task, state: 'failed' }, [], [...blockedEvidence, ev('validation', 34, { exitCode: 0 }), ev('validation', 35, { exitCode: 0 })]);
  assert.deepEqual(member(multiplePassingChecks, 'build', 'general-developer').items[0]!.chips[1], { tone: 'ok', text: 'Tests ✓' }, 'several passing commands are not failed test attempts');
  const cancelled = board({ ...task, state: 'cancelled' }, [], evidence.slice(0, -2));
  assert.equal(stage(cancelled, 'qa').status, 'aborted');
  assert.equal(cancelled.counts.working, 0);
  const historical = board({ ...task, state: 'completed' }, [], []);
  assert.equal(historical.stages.some(s => s.key === 'qa'), false);
  assert.equal(historical.notNeeded.find(m => m.id === 'qa-engineer')!.reason, 'not assigned by the plan');
  const disabled = board({ ...task, state: 'completed' }, [], [ev('qa-assignment', 5, { state: 'skipped', reason: 'QA is disabled; use your pipeline for verification' })]);
  assert.equal(disabled.stages.some(s => s.key === 'qa'), false);
  assert.match(disabled.notNeeded.find(m => m.id === 'qa-engineer')!.reason!, /QA is disabled/);
});

test('completed: everyone finished with the commit line; failed: stopped member, aborted sibling, review and commit not reached', () => {
  const { evidence, items } = multiRunning();
  const done = board(base({ state: 'completed', outcome: { commit: 'd2a676a1234' } }), items.map(i => ({ ...i, state: 'completed' })), [...evidence, ev('validation', 380, { workItemId: '@integration', exitCode: 0 }), ...run('rf', 'review', 'code-reviewer', 385, 400, { workItemId: '@integration' }, approved), ev('commit-created', 405, { commit: 'd2a676a1234' })]);
  assert.ok(done.stages.every(s => s.status === 'done'), done.stages.map(s => `${s.key}:${s.status}`).join());
  assert.equal(member(done, 'commit', 'devagents').lines[0]!.slice(0, 17), 'Committed d2a676a'); assert.equal(member(done, 'review', 'code-reviewer').lines[0], '2 ✓ · 0 findings · final review approved');
  assert.equal(done.summary, '5 of 6 members involved · 5 finished · 0 working · 0 up next');
  const failedItems = [{ itemId: 'a', state: 'completed', agentId: 'backend-developer', commit: '9c2e1f0abc' }, { itemId: 'b', state: 'failed', agentId: 'frontend-developer', repairCycles: 2, error: 'Repair budget exhausted', reason: 'review requested repairs' }, { itemId: 'c', state: 'aborted', agentId: 'general-developer', reason: 'sibling failed' }];
  const failed = board(base({ state: 'failed', outcome: { error: 'Repair budget exhausted' } }), failedItems, evidence.slice(0, 20));
  assert.equal(stage(failed, 'build').chip.text, '✕ 1 stopped'); const b = member(failed, 'build', 'frontend-developer'); assert.equal(b.status, 'fail'); assert.match(b.lines[0]!, /review requested repairs · Repair budget exhausted · repairs 2$/);
  assert.equal(member(failed, 'build', 'general-developer').status, 'aborted'); assert.equal(member(failed, 'review', 'code-reviewer').status, 'aborted'); assert.equal(member(failed, 'review', 'code-reviewer').lines[1], 'Final review not reached');
  assert.equal(member(failed, 'integrate', 'general-developer').status, 'aborted'); assert.deepEqual(member(failed, 'commit', 'devagents').lines, ['No commit', 'The task stopped first']);
  assert.deepEqual(failed.list.map(m => m.id).slice(0, 2), ['frontend-developer', 'general-developer']); assert.equal(failed.counts.failed, 1); assert.equal(failed.counts.aborted, 2); assert.equal(failed.summary, '5 of 6 members involved · 2 finished · 0 working · 0 up next · 1 stopped · 2 did not get a turn');
  const cancelled = board(base({ state: 'cancelled' }), failedItems.map(i => ({ ...i, state: 'cancelled' })), []);
  assert.equal(stage(cancelled, 'commit').chip.text, 'Cancelled'); assert.equal(member(cancelled, 'build', 'backend-developer').status, 'off');
});

test('a repair reopens the build stage: the member is working again with the repair count, never finished', () => {
  const { evidence, items } = multiRunning();
  const repairing = [...items.slice(0, 2), { itemId: 'c', state: 'repairing', agentId: 'general-developer', repairCycles: 1 }];
  const b = board(base({ state: 'repairing' }), repairing, [...evidence, ev('validation', 380, { workItemId: 'c', exitCode: 1 }), ev('work-item', 381, { itemId: 'c', state: 'repairing' })]);
  const dev = member(b, 'build', 'general-developer'); assert.equal(dev.status, 'busy'); assert.equal(dev.repairing, true); assert.match(dev.lines[0]!, /^c · Module c · repairing 1 · /);
  assert.equal(dev.items[0]!.chips[1]!.text, 'Tests ✕ (exit 1)'); assert.equal(stage(b, 'build').status, 'busy');
});

test('durations and clocks come from recorded timestamps only', () => {
  assert.equal(duration(41_000), '41 s'); assert.equal(duration(130_000), '2 min 10 s'); assert.equal(duration(3_840_000), '1 h 4 min'); assert.equal(duration(-1), '—'); assert.equal(duration(Number.NaN), '—');
  const b = board(base({ state: 'planning', plan: undefined }), [], run('p', 'planning', 'tech-lead', 0), T0 + 90_000);
  assert.equal(member(b, 'plan', 'tech-lead').lines[0], 'Planning now · 1 min 30 s'); assert.equal(stage(b, 'plan').chip.text, '▶ Planning');
  const noRuns = board(base(), [], []); assert.equal(member(noRuns, 'plan', 'tech-lead').lines[0], 'Plan v7 · 3 items', 'no duration without a recorded run');
  assert.equal(itemStatus('interrupted'), 'aborted'); assert.equal(itemStatus('blocked'), 'off'); assert.equal(itemStatus('reviewed'), 'done');
});

test('the fold rule: four full rows stay, finished fold first, then up next, then the rest; working, failed and needs-you never fold', () => {
  const rows = (spec: string): { id: number; status: BoardStatus }[] => spec.split('').map((c, id) => ({ id, status: ({ d: 'done', b: 'busy', n: 'next', f: 'fail', y: 'you', a: 'aborted', o: 'off' } as Record<string, BoardStatus>)[c]! }));
  const shape = (spec: string, limit?: number) => fold(rows(spec), limit).map(r => (r.kind === 'row' ? r.row.status[0] : `[${r.status[0]}${r.rows.length}]`)).join('');
  assert.equal(shape('dddd'), 'dddd'); assert.equal(shape('bbbbb'), 'bbbbb', 'working rows never fold');
  assert.equal(shape('ddddddbbbnn'), '[d6]bbb[n2]', 'finished first, then up next because three full rows remain over the limit');
  assert.equal(shape('dddddbbb'), '[d5]bbb', 'folding finished alone is enough');
  assert.equal(shape('dbbbb'), 'dbbbb', 'a group of one is never folded');
  assert.equal(shape('fffffdd'), 'fffff[d2]', 'failures never fold');
  assert.equal(shape('ybbbbbdn'), 'ybbbbbdn', 'nothing foldable has two members; the stage simply grows');
  assert.equal(shape('ddaaonnn'), '[d2]aao[n3]', 'aborted rows fold only when finished and up next were not enough');
  assert.equal(shape('ddaaonnnbbb'), '[d2][a3][n3]bbb', 'aborted and not-needed share one stack');
  assert.equal(shape('nnnnnn', 2), '[n6]');
  const stack = fold(rows('ddddddbb')).find(r => r.kind === 'stack'); assert.ok(stack && stack.kind === 'stack'); assert.deepEqual(stack.rows.map(r => r.id), [0, 1, 2, 3, 4, 5], 'stack rows keep their order');
});

test('roster members with several items get one row that counts them; an unassigned item names any eligible agent', () => {
  const plan = { items: [item('a', 'general-developer'), item('b', 'general-developer', ['a']), { ...item('c', 'general-developer'), assignedAgent: undefined }], integration: { assignedAgent: 'general-developer', validation: [] } };
  const b = board(base({ plan }), [{ itemId: 'a', state: 'completed', agentId: 'general-developer' }, { itemId: 'b', state: 'running', agentId: 'general-developer' }, { itemId: 'c', state: 'pending' }], []);
  const dev = member(b, 'build', 'general-developer'); assert.deepEqual(dev.lines, ['2 items · 1 integrated · b implementing', 'a, b']); assert.equal(dev.status, 'busy');
  const any = member(b, 'build', '?'); assert.equal(any.name, 'Any eligible agent'); assert.equal(any.status, 'next');
  assert.equal(b.counts.involved, 3, 'the unassigned placeholder is not a roster member');
});

test('review evidence recorded without a run id or roster still reaches the item and a placeholder reviewer', () => {
  const plan = { items: [item('greeting', 'general-developer')], integration: null };
  const evidence: Ev[] = [ev('validation', 10, { workItemId: 'greeting', exitCode: 1 }), ev('validation', 20, { workItemId: 'greeting', exitCode: 0 }), ev('run-completed', 30, { workItemId: 'greeting', phase: 'review', output: approved })];
  const b = board(base({ state: 'completed', plan, agents: undefined, outcome: { commit: 'abc1234567' } }), [{ itemId: 'greeting', state: 'completed' }], evidence);
  assert.deepEqual(member(b, 'build', 'general-developer').items[0]!.chips.map(c => c.text), ['Implemented', 'Tests ✕ then ✓ (2 runs)', 'Review ✓']);
  const reviewer = member(b, 'review', 'reviewer'); assert.equal(reviewer.name, 'Reviewer'); assert.equal(reviewer.status, 'done'); assert.equal(reviewer.lines[0], '1 ✓ · 0 findings');
  assert.equal(b.counts.roster, 0);
});
