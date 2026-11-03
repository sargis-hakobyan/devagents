import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from '../helpers.js';
import { FakeEngine, FixtureValidator } from '../fixtures/fake-engine.js';
import { TaskRunner } from '../../src/orchestration/runner.js';
import { QualityOutput } from '../../src/orchestration/outputs.js';
import { Config } from '../../src/domain/schemas.js';

test('QA is disabled by default: developer validation and review continue without a QA assignment or run', async () => {
  const f = await fixture(); f.service.config.qaEnabled = Config.parse({ schemaVersion: 1 }).qaEnabled;
  const engine = new FakeEngine(); const runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Greeting', mode: 'autonomous' }, 'qa-disabled');
    await runner.idle(); const done = f.store.task(task.id);
    assert.equal(done.state, 'completed', JSON.stringify(done.outcome));
    assert.deepEqual(engine.calls.map(c => c.phase), ['planning', 'implementation', 'review']);
    assert.doesNotMatch(engine.calls[0]!.prompt, /"id":"qa-engineer"/);
    const evidence = f.store.evidence(task.id);
    assert.ok(evidence.some(e => e.kind === 'validation' && (e.data as { exitCode: number }).exitCode === 0));
    const assignment = evidence.find(e => e.kind === 'qa-assignment')!.data as { state: string; reason: string };
    assert.equal(assignment.state, 'skipped'); assert.match(assignment.reason, /QA is disabled/);
    assert.equal(evidence.some(e => e.kind === 'qa-result'), false);
  } finally { await runner.stop(); await f.cleanup(); }
});

test('QA is automatically assigned without a testing item, uses an independent read-only agent, and hands evidence to review', async () => {
  const f = await fixture(); const engine = new FakeEngine();
  const runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Greeting', acceptanceCriteria: ['Keep the interface stable'], mode: 'autonomous' }, 'automatic-qa');
    await runner.idle(); const done = f.store.task(task.id);
    assert.equal(done.state, 'completed', JSON.stringify(done.outcome));
    assert.deepEqual(done.plan!.items[0]!.requiredCapabilities, ['implementation']);
    assert.deepEqual(engine.calls.map(c => c.phase), ['planning', 'implementation', 'qa', 'review']);
    const qa = engine.calls.find(c => c.phase === 'qa')!;
    assert.equal(qa.agent.id, 'qa-engineer'); assert.deepEqual(qa.agent.permissions.writePaths, []);
    assert.match(qa.prompt, /Keep the interface stable/); assert.match(qa.prompt, /Typecheck and lint alone do not prove/);
    assert.match(engine.calls.find(c => c.phase === 'review')!.prompt, /QA report for this diff/);
    const events = f.store.evidence(task.id);
    assert.ok(events.some(e => e.kind === 'qa-assignment' && (e.data as { agentId?: string }).agentId === 'qa-engineer'));
    assert.equal((events.find(e => e.kind === 'qa-result')!.data as { state: string }).state, 'passed');
  } finally { await runner.stop(); await f.cleanup(); }
});

for (const scenario of ['repair', 'blocked', 'missing-criterion', 'duplicate-criterion', 'mutation', 'always-fails'] as const) {
  test(`QA ${scenario} cannot bypass the commit gate`, async () => {
    const f = await fixture(); const engine = new FakeEngine(); const execute = engine.execute.bind(engine); let attempts = 0;
    engine.execute = async request => {
      const result = await execute(request);
      if (request.phase !== 'qa') return result;
      attempts++;
      const report = QualityOutput.parse(result.output);
      if (scenario === 'repair' && attempts === 1 || scenario === 'always-fails') { report.checks[0]!.status = 'failed'; report.checks[0]!.evidence = 'Add the missing greeting behavior'; }
      if (scenario === 'blocked') { report.checks[0]!.status = 'blocked'; report.checks[0]!.evidence = 'Required browser interaction cannot be verified: browser unavailable'; }
      if (scenario === 'missing-criterion') report.checks.pop();
      if (scenario === 'duplicate-criterion') report.checks[1]!.criterionId = report.checks[0]!.criterionId;
      if (scenario === 'mutation') await writeFile(join(request.cwd, 'greeting.cjs'), "module.exports=()=> 'tampered';\n");
      return { output: report };
    };
    const runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
    try {
      const task = f.service.submit({ projectId: 'fixture', request: 'Greeting', mode: 'autonomous' }, scenario);
      await runner.idle(); const done = f.store.task(task.id);
      if (scenario === 'repair') {
        assert.equal(done.state, 'completed', JSON.stringify(done.outcome)); assert.equal(done.outcome!.repairCycles, 1);
        assert.deepEqual(engine.calls.map(c => c.phase), ['planning', 'implementation', 'qa', 'implementation', 'qa', 'review']);
        assert.match(engine.calls.filter(c => c.phase === 'implementation')[1]!.prompt, /QA requested repairs.*\nrequest: Add the missing greeting behavior/);
      } else {
        assert.equal(done.state, 'failed', scenario); assert.equal(done.outcome?.commit, undefined);
        assert.equal(engine.calls.some(c => c.phase === 'review'), false);
        assert.equal(f.store.evidence(task.id).some(e => e.kind === 'commit-created'), false);
        if (scenario === 'blocked') { assert.match(done.outcome!.error!, /QA could not verify required acceptance criteria/); assert.equal(attempts, 1); assert.equal(done.outcome!.repairCycles, 0); assert.equal(f.store.workItems(task.id)[0]!.state, 'implemented'); }
        if (scenario === 'mutation') assert.match(done.outcome!.error!, /Files changed during QA/);
        if (scenario.includes('criterion')) assert.match(done.outcome!.error!, /exactly one result/);
        if (scenario === 'always-fails') assert.equal(attempts, f.service.config.maxRepairCycles + 1);
      }
    } finally { await runner.stop(); await f.cleanup(); }
  });
}

test('cancelling during QA stops the gate and prevents review and commit', async () => {
  const f = await fixture(); const engine = new FakeEngine(); const execute = engine.execute.bind(engine);
  let entered!: () => void; const atQa = new Promise<void>(resolve => { entered = resolve; });
  engine.execute = async request => {
    if (request.phase !== 'qa') return execute(request);
    entered();
    await new Promise<void>((_, reject) => { const abort = () => reject(new Error('QA cancelled')); if (request.signal.aborted) abort(); else request.signal.addEventListener('abort', abort, { once: true }); });
    throw new Error('unreachable');
  };
  const runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Greeting', mode: 'autonomous' }, 'cancel-qa');
    await atQa; f.service.cancel(task.id); await runner.idle();
    assert.equal(f.store.task(task.id).state, 'cancelled');
    assert.equal(f.store.evidence(task.id).some(e => e.kind === 'qa-result' || e.kind === 'commit-created'), false);
  } finally { await runner.stop(); await f.cleanup(); }
});

test('QA read permissions are enforced and a team without enabled QA records an explicit skip', async () => {
  for (const noQa of [true, false]) {
    const f = await fixture(); const agents = await f.service.agents('fixture');
    f.service.agents = async () => agents.map(a => a.id === 'qa-engineer' ? { ...a, enabled: !noQa, permissions: { ...a.permissions, readPaths: ['project:/docs/**'] } } : a);
    const engine = new FakeEngine(); const runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
    try {
      const task = f.service.submit({ projectId: 'fixture', request: 'Greeting', mode: 'autonomous' }, `qa-permission-${noQa}`);
      await runner.idle(); const done = f.store.task(task.id);
      assert.equal(done.state, noQa ? 'completed' : 'failed', JSON.stringify(done.outcome));
      assert.equal(engine.calls.some(c => c.phase === 'qa'), false);
      if (noQa) assert.ok(f.store.evidence(task.id).some(e => e.kind === 'qa-assignment' && (e.data as { state: string }).state === 'skipped'));
      else assert.match(done.outcome!.error!, /qa-engineer cannot read/);
    } finally { await runner.stop(); await f.cleanup(); }
  }
});

test('QA uses the submitted team revision even if QA is disabled before plan approval', async () => {
  const f = await fixture(); const engine = new FakeEngine();
  const templates = await f.service.templates();
  const members = ['tech-lead', 'general-developer', 'qa-engineer', 'code-reviewer'].map(id => templates.find(t => t.id === id)!);
  const team = f.service.createTeam({ name: 'QA snapshot', members: members.map(m => m.id === 'qa-engineer' ? { ...m, name: 'Original QA' } : m) });
  const runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Greeting', teamId: team.id, mode: 'plan-approval' }, 'frozen-qa');
    await runner.idle(); const pending = f.store.task(task.id);
    f.service.updateTeam(team.id, team.revision, { name: 'QA snapshot', members: members.map(m => m.id === 'qa-engineer' ? { ...m, enabled: false, name: 'Disabled QA' } : m) });
    f.service.approve(task.id, pending.version); await runner.idle();
    assert.equal(f.store.task(task.id).state, 'completed');
    assert.equal(engine.calls.find(c => c.phase === 'qa')!.agent.name, 'Original QA');
  } finally { await runner.stop(); await f.cleanup(); }
});
