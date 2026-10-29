import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../dist/persistence/store.js';
import { TaskService } from '../dist/orchestration/service.js';
import { TaskRunner } from '../dist/orchestration/runner.js';
import { Config } from '../dist/domain/schemas.js';
import { CodexValidator } from '../dist/engines/codex/validator.js';
import { git } from '../dist/workspace/git.js';
import { CodexAdapter } from '../dist/engines/codex/adapter.js';

// An opt-in live run uses the explicitly supplied DevAgents credential profile.
// The default uses deterministic engine responses but real sandboxed tests and Git.
const live = process.argv.includes('--live');
const root = await mkdtemp(join(tmpdir(), 'devagents-m2-'));
const project = join(root, 'fixture'); const data = join(root, 'data');
let store; let runner;
try {
  execFileSync('git', ['init', '-q', '-b', 'main', project]);
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'devagents-fixture', private: true, scripts: { test: 'node --test greeting.test.cjs' } }));
  await writeFile(join(project, 'greeting.cjs'), "module.exports = () => 'broken';\n");
  await writeFile(join(project, 'greeting.test.cjs'), "const test = require('node:test'); const assert = require('node:assert/strict'); const greet = require('./greeting.cjs'); test('greeting', () => assert.equal(greet(), 'hello'));\n");
  execFileSync('git', ['-C', project, 'add', '.']);
  execFileSync('git', ['-C', project, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Initial fixture']);
  await mkdir(data);
  store = new Store(join(data, 'state.db'));
  const config = Config.parse({ schemaVersion: 1, executionTimeoutMs: 180000 });
  const service = new TaskService(store, config, data);
  await service.registerProject({ id: 'fixture', path: project });
  const engine = live ? new CodexAdapter(process.env.DEVAGENTS_DATA_DIR ?? '.devagents') : {
    id: 'codex', async preflight() {},
    async execute(request) {
      if (request.phase === 'planning') return { output: { summary: 'Fix greeting', risks: [], integration: null, items: [{ id: 'fix', ownedPaths: ['project:/**'], title: 'Fix greeting', description: 'Return hello', acceptanceCriteria: ['Existing test passes'], dependsOn: [], requiredCapabilities: ['implementation'], assignedAgent: 'general-developer', projectId: 'fixture', branch: await git(request.cwd, ['branch', '--show-current']), validation: [{ executable: 'node', args: ['--test', 'greeting.test.cjs'] }] }] } };
      if (request.phase === 'implementation') { await writeFile(join(request.cwd, 'greeting.cjs'), "module.exports = () => 'hello';\n"); return { output: { summary: 'Fixed greeting' } }; }
      return { output: { approved: true, summary: 'Fixture reviewed', findings: [] } };
    },
  };
  runner = new TaskRunner(service, engine, new CodexValidator(data)); service.attachRunner(runner);
  const task = service.submit({ projectId: 'fixture', request: 'Fix greeting.cjs so the existing greeting.test.cjs test passes: return hello. Do not change the existing test or package.json. Plan exactly one implementation item and validate with node --test greeting.test.cjs.', mode: 'autonomous' }, 'smoke');
  await runner.idle();
  const done = store.task(task.id);
  assert.equal(done.state, 'completed', JSON.stringify(done.outcome));
  assert.match(done.outcome.commit, /^[a-f0-9]{40}$/);
  assert.equal(await readFile(join(project, 'greeting.cjs'), 'utf8'), "module.exports = () => 'broken';\n");
  assert.equal(await git(done.workspace.path, ['status', '--porcelain']), '');
  console.log(`PASS: ${live ? 'live Codex' : 'deterministic engine'} plan/implementation, real sandboxed validation, separate review and local commit; original checkout untouched.`);
  if (!live) {
    // Exercise actual sandbox containment with hostile fixture code and fake secrets.
    const sentinel = join(root, 'service-credential'); await writeFile(sentinel, 'fake-secret');
    await writeFile(join(done.workspace.path, 'escape.test.cjs'), `const fs=require('node:fs'); const test=require('node:test'); const assert=require('node:assert/strict'); test('containment',()=>{assert.throws(()=>fs.readFileSync(${JSON.stringify(sentinel)})); assert.throws(()=>fs.writeFileSync(${JSON.stringify(join(project, 'outside'))},'bad')); assert.throws(()=>fs.writeFileSync('.git','bad')); assert.equal(process.env.FAKE_SERVICE_SECRET,undefined);});`);
    process.env.FAKE_SERVICE_SECRET = 'not-a-real-secret';
    const check = await new CodexValidator(data).execute(done.workspace.path, { executable: 'node', args: ['--test', 'escape.test.cjs'] }, new AbortController().signal, 15000);
    assert.equal(check.exitCode, 0, check.output);
    console.log('PASS: validation cannot read service credentials, write original checkout/Git metadata, or inherit service secrets.');
  }
} finally {
  await runner?.stop(); store?.close();
  await rm(root, { recursive: true, force: true });
}
