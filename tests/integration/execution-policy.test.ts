import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, validPlan } from '../helpers.js';
import { Config } from '../../src/domain/schemas.js';
import { taskRules } from '../../src/domain/execution-policy.js';
import { assertValidationCommand } from '../../src/domain/validation.js';
import { validatePlan } from '../../src/domain/plan.js';
import { FakeEngine } from '../fixtures/fake-engine.js';
import { TaskRunner } from '../../src/orchestration/runner.js';
import { CodexValidator } from '../../src/engines/codex/validator.js';
import { git } from '../../src/workspace/git.js';
import type { EngineRequest } from '../../src/domain/engine.js';
import { loadConfig } from '../../src/config.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CODEX_VERSION } from '../../src/engines/codex/sandbox.js';
const installed = await promisify(execFile)('codex', ['--version'], { timeout: 5000 }).then(r => r.stdout.trim() === `codex-cli ${CODEX_VERSION}`, () => false);

test('extra rules default off; env parsing is explicit and overrides file configuration', async () => {
  assert.equal(Config.parse({ schemaVersion: 1 }).devagentsRules, false);
  assert.equal(taskRules({}), true, 'legacy tasks retain strict policy');
  const f = await fixture(); const previous = process.env.DEVAGENTS_RULES;
  try {
    const path = join(f.root, 'config.yaml'); await writeFile(path, 'schemaVersion: 1\ndevagentsRules: true\n');
    delete process.env.DEVAGENTS_RULES;
    assert.equal((await loadConfig(path)).devagentsRules, true);
    process.env.DEVAGENTS_RULES = 'false'; assert.equal((await loadConfig(path)).devagentsRules, false);
    process.env.DEVAGENTS_RULES = 'true'; assert.equal((await loadConfig(path)).devagentsRules, true);
    process.env.DEVAGENTS_RULES = 'no'; await assert.rejects(loadConfig(path), /must be true or false/);
  } finally { if (previous === undefined) delete process.env.DEVAGENTS_RULES; else process.env.DEVAGENTS_RULES = previous; await f.cleanup(); }
});

test('policy is frozen after idempotency resolution and cannot be supplied through task input', async () => {
  const f = await fixture(false);
  try {
    const input = { projectId: 'fixture', request: 'Project checks', mode: 'plan-approval' };
    const first = f.service.submit(input, 'stable'); assert.equal(first.devagentsRules, false);
    f.service.config.devagentsRules = true;
    const retried = f.service.submit(input, 'stable'); assert.equal(retried.id, first.id); assert.equal(retried.devagentsRules, false);
    assert.equal(f.service.submit(input, 'new').devagentsRules, true);
    assert.throws(() => f.service.submit({ ...input, devagentsRules: false }, 'forged'), /Unrecognized key/);
    const plan = validPlan(); plan.items[0]!.validation = [{ executable: 'pnpm', args: ['run', 'check:ui'] }];
    assert.equal((await f.service.proposePlan(first.id, plan)).state, 'awaiting_plan_approval');
    await assert.rejects(f.service.proposePlan(f.service.submit(input, 'strict').id, plan), /Validation supports/);
  } finally { await f.cleanup(); }
});

test('engine policy accepts project commands and exact owned paths while preserving plan structure checks', async () => {
  const f = await fixture(false);
  try {
    const agents = await f.service.agents('fixture');
    const plan = { ...validPlan(), items: [{ ...validPlan().items[0]!, assignedAgent: 'general-developer', ownedPaths: ['project:/greeting.cjs'], validation: [{ executable: 'yarn', args: ['check'] }] }] };
    assert.equal(validatePlan(plan, 'fixture', agents, { platform: 'linux', devagentsRules: false }).items.length, 1);
    assert.throws(() => validatePlan(plan, 'fixture', agents, { platform: 'linux', devagentsRules: true }), /Exact-file writes/);
    assert.throws(() => validatePlan(plan, 'another', agents, { devagentsRules: false }), /another project/);
    const multi = { ...plan, items: ['a', 'b'].map(id => ({ ...plan.items[0]!, id, branch: `codex/${id}` })), integration: { assignedAgent: 'code-reviewer', validation: [{ executable: 'pnpm', args: ['test'] }] } };
    assert.throws(() => validatePlan(multi, 'fixture', agents, { devagentsRules: false }), /writable integration agent/);
    assert.throws(() => assertValidationCommand({ executable: 'node\0', args: [] }, false), /NUL/);
    assert.throws(() => assertValidationCommand({ executable: 'node', args: ['bad\0arg'] }, false), /NUL/);
  } finally { await f.cleanup(); }
});

test('default policy reaches a real sandbox for a custom command, preserves argv and allows generated output', { skip: installed ? false : 'Pinned Codex sandbox not installed' }, async () => {
  const f = await fixture(false); const engine = new FakeEngine(); const original = engine.execute.bind(engine);
  const argument = 'literal; $(not-a-shell-command)';
  const validation = { executable: process.execPath, args: ['-e', `const fs=require('node:fs'),assert=require('node:assert/strict'); assert.equal(process.argv[1],${JSON.stringify(argument)}); assert.equal(require('./greeting.cjs')(),'hello'); fs.writeFileSync('cache/generated.local','ok');`, argument] };
  await writeFile(join(f.project, '.gitignore'), 'cache/\n'); await git(f.project, ['add', '.gitignore']); await git(f.project, ['commit', '-m', 'Fixture ignore']);
  // Register again is not needed: the task worktree records the current checkout HEAD.
  engine.execute = async (request: EngineRequest) => {
    const result = await original(request);
    if (request.phase === 'planning') {
      const plan = result.output as ReturnType<typeof validPlan>;
      plan.items[0]!.validation = [validation];
    }
    if (request.phase === 'implementation') {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(request.cwd, 'cache')); await writeFile(join(request.cwd, 'cache/worker.local'), 'generated');
    }
    return result;
  };
  const runner = new TaskRunner(f.service, engine, new CodexValidator(f.dataDir)); f.service.attachRunner(runner);
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Greeting', mode: 'plan-approval' }, 'engine');
    await runner.idle(); const pending = f.store.task(task.id); assert.equal(pending.state, 'awaiting_plan_approval', JSON.stringify(pending.outcome));
    f.service.config.devagentsRules = true; // changing the default must not reinterpret approval
    f.service.approve(task.id, pending.version); await runner.idle();
    const done = f.store.task(task.id); assert.equal(done.state, 'completed', JSON.stringify(done.outcome));
    assert.equal(await readFile(join(done.workspace!.path, 'cache/generated.local'), 'utf8'), 'ok');
    assert.ok(engine.calls.every(c => c.devagentsRules === false));
    assert.match(engine.calls[0]!.prompt, /actual validation commands/);
    assert.doesNotMatch(engine.calls[0]!.prompt, /supported forms only/);
    assert.equal(await readFile(join(f.project, 'README.md'), 'utf8'), '# Fixture\n');
    await assert.rejects(new CodexValidator(f.dataDir).execute(done.workspace!.path, validation, new AbortController().signal, 10000, true), /Validation supports/);
  } finally { await runner.stop(); await f.cleanup(); }
});
