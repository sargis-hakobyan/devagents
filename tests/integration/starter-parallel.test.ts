import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture } from '../helpers.js';
import { FixtureValidator } from '../fixtures/fake-engine.js';
import type { CodingEngine, EngineRequest } from '../../src/domain/engine.js';
import { TaskRunner } from '../../src/orchestration/runner.js';
import { TaskService } from '../../src/orchestration/service.js';
import { git } from '../../src/workspace/git.js';
import { teamBoard, type BoardInput, type TeamBoard } from '../../ui/src/team-board.js';

test('the starter runs frontend and backend concurrently and exposes both on the live team board', async () => {
  const f = await fixture();
  const service = new TaskService(f.store, { ...f.service.config, qaEnabled: false }, f.dataDir);
  const calls: EngineRequest[] = [];
  let active = 0;
  let liveBoard: TeamBoard | undefined;
  let taskId = '';
  let release!: () => void;
  const bothRunning = new Promise<void>(resolve => { release = resolve; });
  const engine: CodingEngine = {
    id: 'codex', async preflight() {},
    async execute(request) {
      calls.push(request);
      if (request.phase === 'planning') {
        const branch = await git(request.cwd, ['branch', '--show-current']);
        return { output: {
          summary: 'Implement the UI and API against an agreed greeting contract', risks: [], manualChecks: [],
          items: ['frontend', 'backend'].map(id => ({
            id, title: `${id} greeting`, description: 'Greeting contract: return hello', acceptanceCriteria: ['Returns hello'],
            assignedAgent: `${id}-developer`, requiredCapabilities: ['implementation', id], dependsOn: [],
            projectId: 'fixture', branch: `${branch}-${id}`, ownedPaths: [`project:/${id}/**`],
            validation: [{ executable: 'node', args: ['--test', `${id}.test.cjs`] }],
          })),
          integration: { assignedAgent: 'backend-developer', validation: [{ executable: 'node', args: ['--test', 'frontend.test.cjs', 'backend.test.cjs', 'combined.test.cjs'] }] },
        } };
      }
      if (request.phase === 'setup') return { output: { ready: true, summary: 'Fixture tools ready' } };
      if (request.phase === 'review') return { output: { approved: true, summary: 'Independent review passed', findings: [], limitations: [] } };
      assert.equal(request.phase, 'implementation');
      active++;
      if (active === 2) {
        liveBoard = teamBoard({ task: f.store.task(taskId), items: f.store.workItems(taskId) as BoardInput['items'], evidence: f.store.evidence(taskId), now: Date.now() });
        release();
      }
      const deadline = new AbortController();
      try {
        await Promise.race([bothRunning, delay(10000, undefined, { signal: AbortSignal.any([request.signal, deadline.signal]) }).then(() => { throw new Error('Frontend and backend did not overlap'); })]);
        await writeFile(join(request.cwd, request.workItemId!, 'greeting.cjs'), "module.exports = () => 'hello';\n");
        return { output: { summary: `${request.workItemId} implemented`, limitations: [] } };
      } finally { active--; deadline.abort(); }
    },
  };
  const runner = new TaskRunner(service, engine, new FixtureValidator());
  try {
    for (const id of ['frontend', 'backend']) {
      await mkdir(join(f.project, id));
      await writeFile(join(f.project, id, 'greeting.cjs'), "module.exports = () => 'unfinished';\n");
      await writeFile(join(f.project, `${id}.test.cjs`), `const test = require('node:test'); const assert = require('node:assert/strict'); test('${id}', () => assert.equal(require('./${id}/greeting.cjs')(), 'hello'));\n`);
    }
    await writeFile(join(f.project, 'combined.test.cjs'), "const test = require('node:test'); const assert = require('node:assert/strict'); test('both sides match the agreed contract', () => { assert.equal(require('./frontend/greeting.cjs')(), 'hello'); assert.equal(require('./backend/greeting.cjs')(), 'hello'); });\n");
    await git(f.project, ['add', '.']); await git(f.project, ['commit', '-m', 'Fixture contracts']);
    const originalHead = await git(f.project, ['rev-parse', 'HEAD']);
    const starter = await service.initializeStarterTeam();
    assert.deepEqual(starter.members.map(m => m.id), ['tech-lead', 'frontend-developer', 'backend-developer', 'code-reviewer']);
    assert.equal(service.config.concurrency, 2);
    service.attachRunner(runner);
    const task = service.submit({ projectId: 'fixture', request: 'Implement the frontend and backend greeting in parallel', mode: 'autonomous' }, 'parallel-starter');
    taskId = task.id;
    await runner.idle();
    const done = f.store.task(task.id);
    assert.equal(done.state, 'completed', JSON.stringify(done.outcome));
    assert.ok(liveBoard, 'observe the real in-flight store while both implementations are open');
    assert.deepEqual(liveBoard.stages.find(s => s.key === 'build')!.members.map(m => [m.name, m.status, m.items[0]!.state]), [
      ['Frontend Developer', 'busy', 'running'], ['Backend Developer', 'busy', 'running'],
    ]);
    assert.equal(liveBoard.counts.working, 2);
    const implementations = calls.filter(c => c.phase === 'implementation');
    assert.equal(implementations.length, 2);
    assert.equal(new Set(implementations.map(c => c.cwd)).size, 2, 'specialists work in separate worktrees');
    for (const call of implementations) assert.deepEqual(call.agent.permissions.writePaths, [`project:/${call.workItemId}/**`]);
    assert.ok(calls.some(c => c.phase === 'review' && c.workItemId === '@integration' && c.agent.id === 'code-reviewer'));
    assert.equal(calls.some(c => c.phase === 'qa'), false);
    assert.ok(done.outcome?.commit);
    assert.equal(await git(f.project, ['rev-parse', 'HEAD']), originalHead);
    assert.match(await readFile(join(f.project, 'frontend/greeting.cjs'), 'utf8'), /unfinished/);
  } finally { release(); await runner.stop(); await f.cleanup(); }
});
