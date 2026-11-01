import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, symlink, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from '../helpers.js';
import { git } from '../../src/workspace/git.js';
import { NodeEnvironmentPreparer, type DependencyInstaller, type EnvironmentEvent } from '../../src/workspace/environment.js';
import { TaskRunner } from '../../src/orchestration/runner.js';
import { FakeEngine, FixtureValidator } from '../fixtures/fake-engine.js';
import { assertValidationEnvironment } from '../../src/domain/validation.js';

async function nodeProject(f: Awaited<ReturnType<typeof fixture>>, extra = {}) {
  await writeFile(join(f.project, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { example: '1.0.0' }, ...extra }));
  await writeFile(join(f.project, 'package-lock.json'), '{}');
  await writeFile(join(f.project, '.gitignore'), 'node_modules/\n');
  await git(f.project, ['add', '.']); await git(f.project, ['commit', '-qm', 'Node fixture']);
}
const request = (cwd: string) => ({ cwd, commands: [{ executable: 'node', args: ['--test'] }], signal: new AbortController().signal, rules: true });
const fakeInstall: DependencyInstaller = { async install(cwd) {
  await mkdir(join(cwd, 'node_modules/example'), { recursive: true });
  await writeFile(join(cwd, 'node_modules/example/index.js'), 'module.exports = 42;');
  return { exitCode: 0, output: 'fixture dependencies installed' };
} };

test('preparation copies only metadata, skips hooks/secrets/source, refreshes changed manifests and preserves project files', async () => {
  const f = await fixture(false); let calls = 0; const events: EnvironmentEvent[] = [];
  try {
    await nodeProject(f, { scripts: { postinstall: 'DO NOT EXECUTE' } });
    await writeFile(join(f.project, '.npmrc'), 'synthetic private config');
    await writeFile(join(f.project, 'source.ts'), 'private source');
    const installer: DependencyInstaller = { async install(cwd, manager, signal) {
      calls++; assert.equal(manager, 'npm');
      assert.equal(JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')).scripts, undefined);
      for (const p of ['.npmrc', 'source.ts', '.git']) await assert.rejects(access(join(cwd, p)));
      return fakeInstall.install(cwd, manager, signal);
    } };
    const preparer = new NodeEnvironmentPreparer(f.dataDir, installer);
    const before = await git(f.project, ['diff']);
    await preparer.prepare(request(f.project), e => events.push(e));
    assert.equal(await readFile(join(f.project, 'node_modules/example/index.js'), 'utf8'), 'module.exports = 42;');
    await preparer.prepare(request(f.project), () => {}); assert.equal(calls, 1);
    await writeFile(join(f.project, 'package.json'), JSON.stringify({ dependencies: { example: '2.0.0' } }));
    await preparer.prepare(request(f.project), () => {}); assert.equal(calls, 2);
    assert.equal(before, ''); assert.equal(events.at(-1)?.state, 'ready');
    assert.equal(await readFile(join(f.project, '.npmrc'), 'utf8'), 'synthetic private config');
  } finally { await f.cleanup(); }
});

test('dependency-free Node projects report ready once without downloading or requiring a lockfile', async () => {
  const f = await fixture(false); const events: EnvironmentEvent[] = [];
  try {
    await writeFile(join(f.project, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node --test' } }));
    const prep = new NodeEnvironmentPreparer(f.dataDir, { async install() { throw new Error('Must not install'); } });
    await prep.prepare(request(f.project), e => events.push(e));
    await prep.prepare(request(f.project), e => events.push(e));
    assert.deepEqual(events.map(e => e.state), ['checking', 'ready']);
  } finally { await f.cleanup(); }
});

test('unsupported runtime, missing lock, external dependency and escaping install links fail explicitly', async () => {
  const f = await fixture(false);
  try {
    await nodeProject(f, { engines: { node: '>=999' } });
    const prep = new NodeEnvironmentPreparer(f.dataDir, fakeInstall);
    await assert.rejects(prep.prepare(request(f.project), () => {}), /Environment blocked: Project requires Node/);
    await writeFile(join(f.project, 'package.json'), JSON.stringify({ dependencies: { example: 'file:../outside' } }));
    await assert.rejects(prep.prepare(request(f.project), () => {}), /Local-file or Git dependencies/);
    await writeFile(join(f.project, 'package.json'), JSON.stringify({ packageManager: 'yarn@4.0.0' }));
    await assert.rejects(prep.prepare(request(f.project), () => {}), /preparation for yarn/);
    await writeFile(join(f.project, 'package.json'), JSON.stringify({ dependencies: { example: '1.0.0' } }));
    const hostile = new NodeEnvironmentPreparer(f.dataDir, { async install(cwd) {
      await mkdir(join(cwd, 'node_modules')); await symlink('/tmp', join(cwd, 'node_modules/escape'));
      return { output: '', exitCode: 0 };
    } });
    await assert.rejects(hostile.prepare(request(f.project), () => {}), /unsafe symlink/);
    await git(f.project, ['rm', 'package-lock.json']);
    await assert.rejects(prep.prepare(request(f.project), () => {}), /Commit package-lock.json/);
  } finally { await f.cleanup(); }
});

test('pnpm workspace metadata retains patches and overrides but cannot load repository install hooks', async () => {
  const f = await fixture(false);
  try {
    await nodeProject(f, { packageManager: 'pnpm@10.33.0' });
    await writeFile(join(f.project, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0');
    await writeFile(join(f.project, 'pnpm-workspace.yaml'), 'packages: ["packages/*"]\noverrides: {example: "1.0.0"}\npnpmfile: evil.cjs\npatchedDependencies: {example: patches/example.patch}\n');
    await mkdir(join(f.project, 'patches')); await writeFile(join(f.project, 'patches/example.patch'), 'fixture patch');
    await git(f.project, ['add', '.']);
    const prep = new NodeEnvironmentPreparer(f.dataDir, { async install(cwd) {
      const config = await readFile(join(cwd, 'pnpm-workspace.yaml'), 'utf8');
      assert.match(config, /overrides/); assert.doesNotMatch(config, /pnpmfile|evil/);
      assert.equal(await readFile(join(cwd, 'patches/example.patch'), 'utf8'), 'fixture patch');
      return { exitCode: 1, output: 'offline fixture download failure' };
    } });
    await assert.rejects(prep.prepare(request(f.project), () => {}), /offline fixture download failure/);
  } finally { await f.cleanup(); }
});

test('Mastra prepares only after approval and environment failures never invoke implementer or consume repairs', async () => {
  const f = await fixture(true); const engine = new FakeEngine(); let preparations = 0;
  const runner = new TaskRunner(f.service, engine, new FixtureValidator(), { async prepare() { preparations++; throw new Error('Environment blocked: fixture dependency unavailable'); } });
  f.service.attachRunner(runner);
  try {
    const submitted = f.service.submit({ projectId: 'fixture', request: 'Greeting', mode: 'plan-approval' }, 'environment');
    await runner.idle(); assert.equal(preparations, 0);
    const waiting = f.store.task(submitted.id);
    f.service.approve(submitted.id, waiting.version); await runner.idle();
    const done = f.store.task(submitted.id);
    assert.equal(done.state, 'failed'); assert.equal(done.outcome?.repairCycles, 0);
    assert.match(String(done.outcome?.error), /Environment blocked/);
    assert.deepEqual(engine.calls.map(c => c.phase), ['planning']);
    assert.equal(f.store.evidence(done.id).some(e => e.kind === 'workflow-step' && (e.data as {step:string}).step === 'prepare-environment'), true);
  } finally { await runner.stop(); await f.cleanup(); }
});

test('missing dependency validation is retained as evidence and stops without a repair call', async () => {
  const f = await fixture(true); const engine = new FakeEngine();
  const runner = new TaskRunner(f.service, engine, { async execute(_cwd, command) {
    return { ...command, exitCode: 1, output: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'jiti' imported from /workspace/" };
  } }); f.service.attachRunner(runner);
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Greeting', mode: 'autonomous' }, 'missing');
    await runner.idle(); const done = f.store.task(task.id);
    assert.equal(done.state, 'failed'); assert.equal(done.outcome?.repairCycles, 0);
    assert.equal(engine.calls.filter(c => c.phase === 'implementation').length, 1);
    assert.equal(f.store.evidence(task.id).some(e => e.kind === 'validation'), true);
    assert.match(String(done.outcome?.error), /Environment blocked/);
    assert.doesNotThrow(() => assertValidationEnvironment({ executable: 'node', exitCode: 1, output: 'AssertionError: expected 42, received 0' }));
  } finally { await runner.stop(); await f.cleanup(); }
});

test('cancellation during environment preparation drains the task without calling an implementer', async () => {
  const f = await fixture(true); const engine = new FakeEngine();
  let started!: () => void; const preparing = new Promise<void>(resolve => { started = resolve; });
  const runner = new TaskRunner(f.service, engine, new FixtureValidator(), { async prepare({ signal }) {
    started(); await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Preparation cancelled')), { once: true }));
  } }); f.service.attachRunner(runner);
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Greeting', mode: 'autonomous' }, 'cancel-preparation');
    await preparing; f.service.cancel(task.id); await runner.idle();
    assert.equal(f.store.task(task.id).state, 'cancelled');
    assert.deepEqual(engine.calls.map(c => c.phase), ['planning']);
  } finally { await runner.stop(); await f.cleanup(); }
});
