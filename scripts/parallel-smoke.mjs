// Deterministic top-level concurrency with real sandbox validation and Git; no model requests.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Config } from '../dist/domain/schemas.js';
import { Store } from '../dist/persistence/store.js';
import { TaskService } from '../dist/orchestration/service.js';
import { TaskRunner } from '../dist/orchestration/runner.js';
import { CodexValidator } from '../dist/engines/codex/validator.js';
import { git } from '../dist/workspace/git.js';

if (process.env.DEVAGENTS_TEST_DATABASE !== '1') throw Error('Run this fixture with scripts/with-test-postgres.mjs');
const root = await mkdtemp(join(tmpdir(), 'devagents-parallel-'));
let store; let runner; let release; let notify;
const barrier = new Promise(resolve => { release = resolve; });
const started = new Promise(resolve => { notify = resolve; });
const implementations = new Set();
try {
  const project = join(root, 'project'); const data = join(root, 'data'); await mkdir(project); await mkdir(data);
  await git(project, ['init', '-q', '-b', 'main']);
  await writeFile(join(project, 'README.md'), '# Parallel fixture\n'); await git(project, ['add', '.']);
  await git(project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture']);
  const head = await git(project, ['rev-parse', 'HEAD']);
  store = await Store.open(join(data, 'state.db'));
  const config = Config.parse({ schemaVersion: 1, devagentsRules: true, maxConcurrentTasks: 2, maxConcurrentOperations: 2 });
  const service = await TaskService.create(store, config, data); await service.registerProject({ id: 'fixture', path: project });
  const engine = { id: 'codex', async preflight() {}, async execute(request) {
    if (request.phase === 'planning') return { output: { summary: 'Write one isolated result', risks: [], integration: null, items: [{
      id: 'result', title: 'Result', description: 'Write result and test', acceptanceCriteria: ['The result identifies this task'],
      dependsOn: [], requiredCapabilities: ['implementation'], projectId: 'fixture', assignedAgent: 'general-developer',
      branch: await git(request.cwd, ['branch', '--show-current']), ownedPaths: ['project:/**'],
      validation: [{ executable: 'node', args: ['--test', 'result.test.cjs'] }],
    }] } };
    if (request.phase === 'implementation') {
      const id = basename(request.cwd); implementations.add(id); if (implementations.size === 2) notify();
      await barrier; request.signal.throwIfAborted();
      await writeFile(join(request.cwd, 'result.txt'), id);
      await writeFile(join(request.cwd, 'result.test.cjs'), `require('node:test')('own result',()=>require('node:assert/strict').equal(require('node:fs').readFileSync('result.txt','utf8'),${JSON.stringify(id)}));`);
      return { output: { summary: 'Wrote isolated result', limitations: [] } };
    }
    return { output: { approved: true, summary: 'Fixture review approved', findings: [], limitations: [] } };
  } };
  runner = new TaskRunner(service, engine, new CodexValidator(data)); service.attachRunner(runner);
  const tasks = await Promise.all(['A', 'B'].map(name => service.submit({ projectId: 'fixture', request: `Parallel ${name}`, mode: 'autonomous' }, name)));
  let timeout;
  try { await Promise.race([started, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Tasks did not overlap')), 30000); })]); }
  finally { clearTimeout(timeout); }
  assert.equal((await runner.scheduling()).active.length, 2); release(); await runner.idle();
  for (const task of tasks) {
    const done = await store.task(task.id); assert.equal(done.state, 'completed', done.outcome?.error);
    assert.equal(await git(project, ['show', `${done.workspace.branch}:result.txt`]), task.id);
    assert.equal((await store.evidence(task.id)).filter(e => e.kind === 'commit-created').length, 1);
    assert.equal((await store.evidence(task.id)).filter(e => e.kind === 'validation' && e.data.exitCode === 0).length, 1);
    assert.ok((await store.evidence(task.id)).some(e => e.kind === 'terminal-cleanup'));
    await assert.rejects(access(done.workspace.path), { code: 'ENOENT' });
  }
  assert.equal(await git(project, ['rev-parse', 'HEAD']), head); assert.equal(await git(project, ['status', '--porcelain']), '');
  console.log('PASS: two top-level tasks overlap, validate in real sandboxes, retain separate reviewed commits, and clean up without changing the original checkout.');
} finally { release(); await runner?.stop(); await store?.close(); await rm(root, { recursive: true, force: true }); }
