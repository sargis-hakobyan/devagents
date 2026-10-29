import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/persistence/store.js';
import { TaskService } from '../dist/orchestration/service.js';
import { TaskRunner } from '../dist/orchestration/runner.js';
import { Config } from '../dist/domain/schemas.js';
import { CodexAdapter } from '../dist/engines/codex/adapter.js';
import { CodexValidator } from '../dist/engines/codex/validator.js';
import { git } from '../dist/workspace/git.js';

const live = process.argv.includes('--live');
const root = await mkdtemp(join(tmpdir(), 'devagents-m3-')); const project = join(root, 'project'); const data = join(root, 'data');
let store; let runner;
try {
  await mkdir(project); await mkdir(data); await git(project, ['init', '-q', '-b', 'main']);
  for (const id of ['a', 'b', 'c']) {
    await writeFile(join(project, `${id}.cjs`), "module.exports=()=> 'broken';\n");
    await writeFile(join(project, `${id}.test.cjs`), `const test=require('node:test'),assert=require('node:assert/strict');test('${id}',()=>assert.equal(require('./${id}.cjs')(),'${id === 'c' ? 'AB' : id.toUpperCase()}'));\n`);
  }
  await git(project, ['add', '.']);
  await git(project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Initial fixture']);
  const original = await git(project, ['rev-parse', 'HEAD']);
  store = new Store(join(data, 'state.db'));
  const service = new TaskService(store, Config.parse({ schemaVersion: 1, concurrency: 2, executionTimeoutMs: 180000 }), data);
  await service.registerProject({ id: 'fixture', path: project });
  const record = store.record.bind(store);
  store.record = (id, kind, value) => {
    record(id, kind, value);
    if (kind === 'work-item') console.log(`Item ${value.itemId}: ${value.state}`);
    if (kind === 'integration-conflict') console.log('Integration conflict: repair required');
  };
  const engine = live ? new CodexAdapter(process.env.DEVAGENTS_DATA_DIR ?? '.devagents') : {
    id: 'codex', async preflight() {}, async execute(request) {
      if (request.phase === 'planning') {
        const branch = await git(request.cwd, ['branch', '--show-current']);
        return { output: { summary: 'Implement independent A/B modules and combine them', risks: [], integration: { assignedAgent: 'general-developer', validation: [{ executable: 'node', args: ['--test', 'a.test.cjs', 'b.test.cjs', 'c.test.cjs'] }] }, items: ['a', 'b', 'c'].map(id => ({ id, title: `Module ${id}`, description: `Implement ${id}`, acceptanceCriteria: ['Existing test passes'], dependsOn: id === 'c' ? ['a', 'b'] : [], requiredCapabilities: ['implementation'], assignedAgent: id === 'a' ? 'backend-developer' : id === 'b' ? 'frontend-developer' : 'general-developer', projectId: 'fixture', branch: `${branch}-${id}`, ownedPaths: [`project:/${id}.cjs`], validation: [{ executable: 'node', args: ['--test', `${id}.test.cjs`] }] })) } };
      }
      if (request.phase === 'implementation') {
        const id = request.workItemId;
        assert.ok(['a', 'b', 'c'].includes(id));
        if (id === 'c') { assert.match(await readFile(join(request.cwd, 'a.cjs'), 'utf8'), /'A'/); assert.match(await readFile(join(request.cwd, 'b.cjs'), 'utf8'), /'B'/); }
        await writeFile(join(request.cwd, `${id}.cjs`), id === 'c' ? "module.exports=()=>require('./a.cjs')()+require('./b.cjs')();\n" : `module.exports=()=> '${id.toUpperCase()}';\n`);
        return { output: { summary: `Implemented module ${id}` } };
      }
      return { output: { approved: true, summary: 'Requirements and actual tests pass', findings: [] } };
    },
  };
  runner = new TaskRunner(service, engine, new CodexValidator(data)); service.attachRunner(runner);
  const task = service.submit({ projectId: 'fixture', mode: 'autonomous', request: 'Plan exactly three implementation items with IDs a, b, c. Item a: assign backend-developer to make a.cjs return A, own only project:/a.cjs, validate with node --test a.test.cjs. Item b: assign frontend-developer to make b.cjs return B, own only project:/b.cjs, validate with node --test b.test.cjs. Items a and b are independent (no dependencies). Item c depends on both a and b: assign general-developer to make c.cjs call the a and b modules and concatenate their results to AB, own only project:/c.cjs, validate with node --test c.test.cjs. Set integration assignedAgent to general-developer and combined validation to node --test a.test.cjs b.test.cjs c.test.cjs. Never modify the existing tests. Keep module.exports as a function in every module.', acceptanceCriteria: ['All three existing tests pass unchanged', 'c.cjs calls the a and b modules', 'Original checkout remains unchanged'] }, 'm3-smoke');
  await runner.idle();
  const done = store.task(task.id);
  assert.equal(done.state, 'completed', JSON.stringify(done.outcome));
  assert.equal(done.plan.items.length, 3);
  assert.equal(store.workItems(task.id).every(i => i.state === 'completed'), true);
  assert.equal(store.evidence(task.id).filter(e => e.kind === 'item-commit-created').length, 3);
  assert.equal(store.evidence(task.id).filter(e => e.kind === 'commit-created').length, 1);
  assert.equal(await git(project, ['rev-parse', 'HEAD']), original);
  assert.equal(await readFile(join(project, 'a.cjs'), 'utf8'), "module.exports=()=> 'broken';\n");
  assert.equal(await git(done.workspace.path, ['status', '--porcelain']), '');
  assert.deepEqual(done.outcome.files, ['a.cjs', 'b.cjs', 'c.cjs']);
  const runs = store.evidence(task.id).filter(e => e.kind === 'run-started' && e.data.phase === 'implementation');
  assert.equal(new Set(runs.filter(e => e.data.workItemId !== '@integration').map(e => e.data.cwd)).size, 3);
  console.log(`PASS: ${live ? 'live Codex' : 'deterministic'} three-item DAG, isolated worktrees, dependencies, real sandboxed validation, independent item/combined reviews, and final local commit; original checkout unchanged.`);
} finally {
  await runner?.stop(); store?.close(); await rm(root, { recursive: true, force: true });
}
