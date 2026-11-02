import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from '../helpers.js';
import { FakeEngine, FixtureValidator } from '../fixtures/fake-engine.js';
import { TaskRunner } from '../../src/orchestration/runner.js';
import type { CodingEngine, EngineRequest } from '../../src/domain/engine.js';
import { git } from '../../src/workspace/git.js';
import { AppError } from '../../src/domain/errors.js';

test('rules-off setup uses the frozen implementer after approval and accepts custom project tooling', async () => {
  const f = await fixture(false); const fake = new FakeEngine(); const calls: EngineRequest[] = [];
  await writeFile(join(f.project, 'package.json'), JSON.stringify({ packageManager: 'yarn@4.0.0', engines: { node: '>=999' } }));
  await git(f.project, ['add', '.']); await git(f.project, ['commit', '-qm', 'Custom tooling fixture']);
  const original = await git(f.project, ['rev-parse', 'HEAD']);
  const engine: CodingEngine = { id: 'codex', preflight: async () => {}, async execute(r, progress) {
    calls.push(r);
    if (r.phase === 'setup') {
      assert.match(r.prompt, /lifecycle scripts/); assert.match(r.prompt, /Validation commands:/);
      assert.equal(r.agent.id, 'general-developer'); assert.equal(r.devagentsRules, false);
      // The engine owns setup; DevAgents does not reject an unfamiliar manager/runtime first.
      await writeFile(join(r.cwd, 'SETUP.md'), 'Reviewed project-specific setup adjustment\n');
      return { output: { ready: true, summary: 'Custom tooling prepared' } };
    }
    return fake.execute(r);
  } };
  const runner = new TaskRunner(f.service, engine, new FixtureValidator(), { async prepare() { throw new Error('Restricted Node preparation must not run'); } });
  f.service.attachRunner(runner);
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Greeting', mode: 'plan-approval' }, 'custom-setup');
    await runner.idle(); assert.deepEqual(calls.map(c => c.phase), ['planning']);
    f.service.approve(task.id, f.store.task(task.id).version); await runner.idle();
    const done = f.store.task(task.id);
    assert.equal(done.state, 'completed', JSON.stringify(done.outcome));
    assert.deepEqual(calls.map(c => c.phase), ['planning', 'setup', 'implementation', 'review']);
    assert.match(calls.find(c => c.phase === 'review')!.prompt, /Reviewed project-specific setup adjustment/);
    assert.ok(done.outcome?.files?.includes('SETUP.md'));
    assert.equal(await git(f.project, ['rev-parse', 'HEAD']), original);
    assert.equal(await git(f.project, ['status', '--porcelain']), '');
  } finally { await runner.stop(); await f.cleanup(); }
});

for (const remainsMissing of [false, true]) test(`missing dependencies get a separate bounded setup recovery (${remainsMissing ? 'still blocked' : 'recovered'})`, async () => {
  const f = await fixture(false); const fake = new FakeEngine(); let setups = 0; let validations = 0; let repairs = 0;
  const engine: CodingEngine = { id: 'codex', preflight: async () => {}, async execute(r) {
    if (r.phase === 'setup') {
      setups++;
      if (setups === 2) {
        assert.match(r.prompt, /Cannot find package 'jiti'/);
        await writeFile(join(r.cwd, 'SETUP.md'), 'Recovery configuration change for review\n');
      }
      return { output: { ready: true, summary: 'Setup ready' } };
    }
    if (r.phase === 'implementation') repairs++;
    return fake.execute(r);
  } };
  const runner = new TaskRunner(f.service, engine, { async execute(_cwd, command) {
    validations++;
    return { ...command, exitCode: remainsMissing || validations === 1 ? 1 : 0,
      output: remainsMissing || validations === 1 ? "Cannot find package 'jiti' imported from /workspace/" : 'passed' };
  } }); f.service.attachRunner(runner);
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Greeting', mode: 'autonomous' }, 'recover-setup');
    await runner.idle(); const done = f.store.task(task.id);
    assert.equal(done.state, remainsMissing ? 'failed' : 'completed', JSON.stringify(done.outcome));
    assert.equal(setups, 2); assert.equal(validations, 2); assert.equal(repairs, 1);
    assert.equal(done.outcome?.repairCycles, 0);
    assert.equal(f.store.evidence(task.id).filter(e => e.kind === 'validation').length, 2);
    if (!remainsMissing) assert.match(fake.calls.find(c => c.phase === 'review')!.prompt, /Recovery configuration change for review/);
  } finally { await runner.stop(); await f.cleanup(); }
});

test('setup cancellation and concrete blockers stop before implementation', async () => {
  for (const cancel of [false, true]) {
    const f = await fixture(false); const fake = new FakeEngine(); let started!: () => void;
    const setupStarted = new Promise<void>(resolve => { started = resolve; });
    const engine: CodingEngine = { id: 'codex', preflight: async () => {}, async execute(r) {
      if (r.phase !== 'setup') return fake.execute(r);
      started();
      if (cancel) await new Promise((_resolve, reject) => r.signal.addEventListener('abort', () => reject(new Error('Cancelled setup')), { once: true }));
      return { output: { ready: false, summary: 'Private registry authentication is required' } };
    } };
    const runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
    try {
      const task = f.service.submit({ projectId: 'fixture', request: 'Greeting', mode: 'autonomous' }, 'setup-blocked');
      await setupStarted; if (cancel) f.service.cancel(task.id);
      await runner.idle(); const done = f.store.task(task.id);
      assert.equal(done.state, cancel ? 'cancelled' : 'failed');
      assert.equal(fake.calls.filter(c => c.phase === 'implementation').length, 0);
      if (!cancel) assert.match(String(done.outcome?.error), /Private registry authentication/);
    } finally { await runner.stop(); await f.cleanup(); }
  }
});

test('a validation command that mutates source cannot hide behind environment recovery', async () => {
  const f = await fixture(false); const fake = new FakeEngine();
  const runner = new TaskRunner(f.service, fake, { async execute(cwd, command) {
    await writeFile(join(cwd, 'README.md'), 'Changed by validation');
    return { ...command, exitCode: 1, output: "Cannot find package 'jiti' imported from /workspace/" };
  } }); f.service.attachRunner(runner);
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Greeting', mode: 'autonomous' }, 'mutating-test');
    await runner.idle(); const done = f.store.task(task.id);
    assert.equal(done.state, 'failed'); assert.match(String(done.outcome?.error), /Validation changed reviewed project files/);
    assert.equal(fake.calls.filter(c => c.phase === 'setup').length, 1);
    assert.equal(await readFile(join(f.project, 'README.md'), 'utf8'), '# Fixture\n');
  } finally { await runner.stop(); await f.cleanup(); }
});

test('setup receives executable-preflight diagnostics once before implementation', async () => {
  const f = await fixture(false); const fake = new FakeEngine(); const base = new FixtureValidator(); let probes = 0;
  const runner = new TaskRunner(f.service, fake, {
    async preflight() { if (++probes === 1) throw new AppError('environment_blocked', 'Missing validation executable: fixture-tool'); },
    execute: (cwd, command, signal, timeout) => base.execute(cwd, command, signal, timeout),
  }); f.service.attachRunner(runner);
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Greeting', mode: 'autonomous' }, 'setup-preflight');
    await runner.idle(); const done = f.store.task(task.id);
    assert.equal(done.state, 'completed', JSON.stringify(done.outcome)); assert.equal(probes, 2);
    assert.equal(done.outcome?.repairCycles, 0);
    const setup = fake.calls.filter(c => c.phase === 'setup'); assert.equal(setup.length, 2);
    assert.match(setup[1]!.prompt, /Missing validation executable: fixture-tool/);
  } finally { await runner.stop(); await f.cleanup(); }
});

test('setup gets one recovery and passes baseline failures to implementation and independent review', async () => {
  const f = await fixture(false); const fake = new FakeEngine(); let setups = 0;
  const note = 'Existing UI test runner cannot parse import type; repair its configuration without removing assertions.';
  const seen: EngineRequest[] = [];
  const engine: CodingEngine = { id: 'codex', preflight: async () => {}, async execute(r) {
    seen.push(r);
    if (r.phase === 'setup') {
      setups++;
      if (setups === 1) return { output: { ready: false, summary: note } };
      assert.match(r.prompt, /Existing UI test runner/);
      return { output: { ready: true, summary: note } };
    }
    return fake.execute(r);
  } };
  const runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Greeting', mode: 'autonomous' }, 'baseline-recovery');
    await runner.idle(); const done = f.store.task(task.id);
    assert.equal(done.state, 'completed', JSON.stringify(done.outcome)); assert.equal(setups, 2);
    assert.equal(done.outcome?.repairCycles, 0);
    for (const phase of ['implementation', 'review']) assert.ok(seen.find(r => r.phase === phase)?.prompt.includes(note));
  } finally { await runner.stop(); await f.cleanup(); }
});

test('review receives actual supplementary repair commands without replacing mandatory validation', async () => {
  const f = await fixture(false); const fake = new FakeEngine(); let implementations = 0; let reviews = 0; let validations = 0;
  const engine: CodingEngine = { id: 'codex', preflight: async () => {}, async execute(r, progress) {
    if (r.phase === 'implementation') {
      implementations++;
      progress({ kind: 'command', data: { command: `database-check-${implementations}`, aggregated_output: implementations === 1 ? 'Database tests skipped' : '3 database tests passed; none skipped', exit_code: implementations === 1 ? 1 : 0 } });
    }
    if (r.phase === 'review') {
      reviews++;
      assert.match(r.prompt, new RegExp(`database-check-${reviews}`));
      assert.match(r.prompt, /Actual validation evidence:/);
      if (reviews === 1) return { output: { approved: false, summary: 'Missing database proof', findings: ['Run database tests'] } };
      assert.doesNotMatch(r.prompt, /database-check-1/);
      assert.match(r.prompt, /3 database tests passed; none skipped/);
    }
    return fake.execute(r);
  } };
  const baseValidator = new FixtureValidator();
  const runner = new TaskRunner(f.service, engine, { execute(cwd, command, signal, timeout) { validations++; return baseValidator.execute(cwd, command, signal, timeout); } });
  f.service.attachRunner(runner);
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Greeting', mode: 'autonomous' }, 'repair-evidence');
    await runner.idle(); const done = f.store.task(task.id);
    assert.equal(done.state, 'completed', JSON.stringify(done.outcome));
    assert.equal(done.outcome?.repairCycles, 1); assert.equal(validations, 2); assert.equal(reviews, 2);
  } finally { await runner.stop(); await f.cleanup(); }
});
