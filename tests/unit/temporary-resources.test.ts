import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexAdapter } from '../../src/engines/codex/adapter.js';
import { CodexValidator } from '../../src/engines/codex/validator.js';
import { loadRegistry, builtinDirectory } from '../../src/agents/registry.js';
import { Config } from '../../src/domain/schemas.js';

test('engine and validator remove per-call scratch on success, failure and cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temporary-resources-'));
  const cwd = join(root, 'project'); await mkdir(cwd);
  const data = join(root, 'data'); const binary = join(root, 'codex');
  const agent = (await loadRegistry([builtinDirectory], Config.parse({ schemaVersion: 1 })))[0]!;
  const adapter = new CodexAdapter(data, binary); const validator = new CodexValidator(data, binary);
  try {
    for (const mode of ['success', 'failure', 'cancel', 'setup-failure']) {
      await writeFile(binary, `#!${process.execPath}
if(process.argv.includes('--version')) { console.log(${JSON.stringify(mode === 'setup-failure' ? 'unsupported' : 'codex-cli 0.160.1')}); process.exit(0); }
if(process.argv.includes('login')) process.exit(0);
require('node:fs').writeFileSync(require('node:path').join(process.env.TMPDIR, 'scratch'), 'temporary data');
if(${JSON.stringify(mode)} === 'cancel') { setInterval(()=>{},1000); }
else if(${JSON.stringify(mode)} === 'failure') { process.exit(1); }
else {
 console.log(JSON.stringify({type:'item.completed', item:{type:'agent_message',text:'{"ok":true}'}}));
 console.log(JSON.stringify({type:'turn.completed'}));
}
`, { mode: 0o700 });
      const signal = () => mode === 'cancel' ? AbortSignal.timeout(300) : new AbortController().signal;
      const result = adapter.execute({ runId: `fixture-${mode}`, phase: 'implementation', cwd, prompt: 'Fixture', agent,
        provider: { id: 'openai', kind: 'openai', auth: 'login' }, schema: {}, signal: signal(), timeoutMs: 5000 }, () => {});
      if (mode === 'success') assert.deepEqual((await result).output, { ok: true });
      else await assert.rejects(result);
      assert.deepEqual(await readdir(join(data, 'runs')), [], `engine ${mode}`);
      const validation = validator.execute(cwd, { executable: 'node', args: ['--test'] }, signal(), 5000);
      if (mode === 'success' || mode === 'failure') assert.equal((await validation).exitCode, mode === 'success' ? 0 : 1);
      else await assert.rejects(validation);
      assert.deepEqual(await readdir(join(data, 'validation')), [], `validator ${mode}`);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
