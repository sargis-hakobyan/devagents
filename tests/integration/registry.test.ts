import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { fixture } from '../helpers.js';
import { loadRegistry } from '../../src/agents/registry.js';

test('config-only roles, deterministic overrides, duplicate IDs and capability validation', async () => {
  const f = await fixture();
  try {
    const builtins = await f.service.agents();
    assert.equal(builtins.length, 6);
    const sample = builtins.find(a => a.id === 'code-reviewer')!;
    const { instructions: _, source: __, ...definition } = sample;
    const user = join(f.dataDir, 'agents'); const project = join(f.project, '.devagents/agents');
    for (const dir of [user, project]) { await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'role.md'), 'Custom instructions'); }
    await writeFile(join(user, 'reviewer.yaml'), stringify({ ...definition, name: 'User reviewer', instructionsFile: 'role.md' }));
    await writeFile(join(project, 'reviewer.yaml'), stringify({ ...definition, name: 'Project reviewer', instructionsFile: 'role.md' }));
    for (const id of ['technical-writer', 'accessibility-reviewer']) await writeFile(join(project, `${id}.yaml`), stringify({ ...definition, id, name: id, instructionsFile: 'role.md' }));
    const registry = await f.service.agents('fixture');
    assert.equal(registry.length, 8); assert.equal(registry.find(a => a.id === 'code-reviewer')!.name, 'Project reviewer');
    await writeFile(join(project, 'invalid.yaml'), stringify({ ...definition, id: 'designer', capabilities: ['asset-design'], instructionsFile: 'role.md' }));
    await assert.rejects(f.service.agents('fixture'), /unavailable capability/);
    await writeFile(join(project, 'invalid.yaml'), stringify({ ...definition, instructionsFile: 'role.md' }));
    await assert.rejects(loadRegistry([project], f.service.config), /Duplicate agent ID/);
  } finally { await f.cleanup(); }
});
test('instruction files cannot escape their registry through symlinks', async () => {
  const f = await fixture();
  try {
    const dir = join(f.dataDir, 'agents'); await mkdir(dir, { recursive: true });
    const { instructions: _, source: __, ...agent } = (await f.service.agents())[0]!;
    await symlink(join(f.project, 'README.md'), join(dir, 'outside.md'));
    await writeFile(join(dir, 'agent.yaml'), stringify({ ...agent, instructionsFile: 'outside.md' }));
    await assert.rejects(f.service.agents(), /symlink escapes/);
  } finally { await f.cleanup(); }
});
test('the entire project override directory cannot be redirected outside the project', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.project, '.devagents'));
    await symlink(f.dataDir, join(f.project, '.devagents', 'agents'));
    await assert.rejects(f.service.agents('fixture'), /directory escapes project/);
  } finally { await f.cleanup(); }
});
