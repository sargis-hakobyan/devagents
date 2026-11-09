import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../helpers.js';
import { FakeEngine, FixtureValidator } from '../fixtures/fake-engine.js';
import { EngineRegistry } from '../../src/engines/registry.js';
import { TaskRunner } from '../../src/orchestration/runner.js';
import { TaskService } from '../../src/orchestration/service.js';
import { AppError } from '../../src/domain/errors.js';
import { assertSignInIdle } from '../../src/setup/auth.js';

for (const role of ['general-developer', 'code-reviewer']) test(`missing ${role} credentials fail before planning or creating a worktree`, async () => {
  const f = await fixture(); const codex = new FakeEngine();
  const engines = new EngineRegistry([codex, { id: 'claude-code', preflight: async () => { throw new AppError('missing_auth', 'Connect Claude in Settings'); }, execute: async () => { throw new Error('Must not call Claude'); } }]);
  const service = new TaskService(f.store, f.service.config, f.dataDir, process.platform, engines.ids());
  const runner = new TaskRunner(service, engines, new FixtureValidator()); service.attachRunner(runner);
  try {
    const members = (await service.templates()).filter(a => ['tech-lead', 'general-developer', 'code-reviewer'].includes(a.id)).map(a => a.id === role ? { ...a, engine: 'claude-code', provider: 'anthropic' } : a);
    const team = service.createTeam({ name: 'Disconnected team', members });
    const task = service.submit({ projectId: 'fixture', teamId: team.id, request: 'Greeting', mode: 'plan-approval' }, role);
    await runner.idle();
    const failed = f.store.task(task.id);
    assert.equal(failed.state, 'failed');
    assert.match(failed.outcome!.error!, /\(claude-code\): Connect Claude in Settings/);
    assert.equal(failed.workspace, undefined); assert.equal(failed.plan, undefined);
    assert.deepEqual(codex.calls, []);
    assert.equal(f.store.evidence(task.id).some(e => e.kind === 'worktree-intent' || e.kind === 'run-started'), false);
  } finally { await runner.stop(); await f.cleanup(); }
});

for (const qaEnabled of [true, false]) test(`inactive Claude QA does not block planning (global QA ${qaEnabled})`, async () => {
  const f = await fixture(); const codex = new FakeEngine();
  const engines = new EngineRegistry([codex, { id: 'claude-code', preflight: async () => { throw new Error('Inactive QA must not preflight'); }, execute: async () => { throw new Error('Must not execute'); } }]);
  const service = new TaskService(f.store, { ...f.service.config, qaEnabled }, f.dataDir, process.platform, engines.ids());
  const runner = new TaskRunner(service, engines, new FixtureValidator()); service.attachRunner(runner);
  try {
    const members = (await service.templates()).filter(a => ['tech-lead', 'general-developer', 'code-reviewer', 'qa-engineer'].includes(a.id)).map(a => a.id === 'qa-engineer' ? { ...a, engine: 'claude-code', provider: 'anthropic', enabled: !qaEnabled } : a);
    const team = service.createTeam({ name: 'Inactive QA', members });
    const task = service.submit({ projectId: 'fixture', teamId: team.id, request: 'Greeting', mode: 'plan-approval' }, 'inactive');
    await runner.idle();
    assert.equal(f.store.task(task.id).state, 'awaiting_plan_approval', JSON.stringify(f.store.task(task.id).outcome));
    assert.deepEqual(codex.calls.map(c => c.phase), ['planning']);
  } finally { await runner.stop(); await f.cleanup(); }
});

test('idle recovered Ready tasks allow sign-in; queued and executing work still blocks it', async () => {
  const f = await fixture();
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Greeting', mode: 'autonomous' }, 'auth-idle');
    assert.throws(() => assertSignInIdle(f.store, { busy: false }), { code: 'work_active' });
    const ready = f.store.transition(task.id, task.version, 'ready', 'test', 'Plan ready');
    assert.doesNotThrow(() => assertSignInIdle(f.store, { busy: false }));
    assert.throws(() => assertSignInIdle(f.store, { busy: true }), { code: 'work_active' });
    f.store.transition(ready.id, ready.version, 'running', 'test', 'Execution started');
    assert.throws(() => assertSignInIdle(f.store, { busy: false }), { code: 'work_active' });
  } finally { await f.cleanup(); }
});

test('a frozen team routes implementation to Claude and repair/review to the assigned engines', async () => {
  const f = await fixture(); const codex = new FakeEngine({ firstReviewRejects: true }); const claude = new FakeEngine();
  const engines = new EngineRegistry([codex, { id: 'claude-code', preflight: claude.preflight.bind(claude), execute: claude.execute.bind(claude) }]);
  const service = new TaskService(f.store, { ...f.service.config, defaultModel: 'codex-fixture-model' }, f.dataDir, process.platform, engines.ids());
  const runner = new TaskRunner(service, engines, new FixtureValidator()); service.attachRunner(runner);
  try {
    const templates = await service.templates();
    const members = ['tech-lead', 'general-developer', 'code-reviewer'].map(id => structuredClone(templates.find(a => a.id === id)!));
    members[1]!.engine = 'claude-code'; members[1]!.provider = 'anthropic';
    const team = service.createTeam({ name: 'Mixed team', members });
    const task = service.submit({ projectId: 'fixture', teamId: team.id, request: 'Greeting', mode: 'plan-approval' }, 'mixed');
    await runner.idle(); assert.equal(f.store.task(task.id).state, 'awaiting_plan_approval');
    const frozen = f.store.task(task.id); assert.equal(frozen.team!.members[1]!.model, 'default', 'Codex default must not leak into Claude');
    members[1]!.engine = 'codex'; members[1]!.provider = 'openai';
    service.updateTeam(team.id, team.revision, { name: team.name, members });
    service.approve(task.id, frozen.version); await runner.idle();
    assert.equal(f.store.task(task.id).state, 'completed', JSON.stringify(f.store.task(task.id).outcome));
    assert.deepEqual(claude.calls.map(c => c.phase), ['implementation', 'implementation']);
    assert.ok(claude.calls.every(c => c.provider.kind === 'anthropic'));
    assert.ok(codex.calls.every(c => c.provider.kind === 'openai'));
    const starts = f.store.evidence(task.id).filter(e => e.kind === 'run-started').map(e => (e.data as { engine: string }).engine);
    assert.deepEqual(starts, ['codex', 'claude-code', 'codex', 'claude-code', 'codex']);
    assert.throws(() => engines.get('ollama'), { code: 'engine_unavailable' });
  } finally { await runner.stop(); await f.cleanup(); }
});
