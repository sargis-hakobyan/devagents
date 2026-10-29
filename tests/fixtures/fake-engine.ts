import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CodingEngine, EngineRequest, EngineResult, Validator } from '../../src/domain/engine.js';
import { git } from '../../src/workspace/git.js';
import { runProcess } from '../../src/engines/process.js';
import { AppError } from '../../src/domain/errors.js';

export class FakeEngine implements CodingEngine {
  readonly id = 'codex';
  calls: EngineRequest[] = [];
  constructor(readonly options: { failFirstTest?: boolean; rejectReviews?: boolean; contradictoryReview?: boolean; mutateReview?: boolean; waitForCancel?: boolean } = {}) {}
  async preflight(): Promise<void> {}
  async execute(request: EngineRequest): Promise<EngineResult> {
    this.calls.push(request);
    if (request.phase === 'planning') return { output: {
      summary: 'Implement greeting', risks: [], integration: null, items: [{ id: 'greeting', ownedPaths: ['project:/**'], title: 'Greeting', description: 'Implement greeting', acceptanceCriteria: ['Returns hello'], dependsOn: [], requiredCapabilities: ['implementation'], assignedAgent: 'general-developer', projectId: 'fixture', branch: await git(request.cwd, ['branch', '--show-current']), validation: [{ executable: 'node', args: ['--test', 'greeting.test.cjs'] }] }],
    } };
    if (request.phase === 'implementation') {
      if (this.options.waitForCancel) await new Promise<void>((_, reject) => {
        const abort = () => reject(new AppError('cancelled', 'Fixture cancelled'));
        if (request.signal.aborted) abort(); else request.signal.addEventListener('abort', abort, { once: true });
      });
      const broken = this.options.failFirstTest && this.calls.filter(c => c.phase === 'implementation').length === 1;
      await writeFile(join(request.cwd, 'greeting.cjs'), `module.exports = () => '${broken ? 'broken' : 'hello'}';\n`);
      await writeFile(join(request.cwd, 'greeting.test.cjs'), "const test = require('node:test'); const assert = require('node:assert/strict'); const greet = require('./greeting.cjs'); test('greeting', () => assert.equal(greet(), 'hello'));\n");
      return { output: { summary: 'Implemented greeting and tests' } };
    }
    if (this.options.mutateReview) await writeFile(join(request.cwd, 'greeting.cjs'), "module.exports = () => 'tampered';\n");
    return { output: { approved: !this.options.rejectReviews, summary: 'Independent fixture review', findings: this.options.rejectReviews || this.options.contradictoryReview ? ['Greeting needs work'] : [] } };
  }
}
// Only used with the hardcoded fixture above, never exposed to user/model commands.
export class FixtureValidator implements Validator {
  async execute(cwd: string, command: { executable: string; args: string[] }, signal: AbortSignal, timeoutMs: number) {
    const result = await runProcess(process.execPath, command.args, { cwd, env: { PATH: process.env.PATH }, signal, timeoutMs });
    return { ...command, exitCode: result.exitCode, output: result.stdout + result.stderr };
  }
}
