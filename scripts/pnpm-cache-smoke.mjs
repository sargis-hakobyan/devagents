import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexValidator } from '../dist/engines/codex/validator.js';
import { workspaceRuntime } from '../dist/engines/node-tools.js';
import { git } from '../dist/workspace/git.js';

// Real pnpm + sandbox, one synthetic loopback tarball. No models, credentials or registry.
const root = await mkdtemp(join(tmpdir(), 'devagents-pnpm-cache-'));
const server = createServer();
try {
  const pack = join(root, 'package'); await mkdir(pack);
  await writeFile(join(pack, 'package.json'), '{"name":"fixture-dep","version":"1.0.0","main":"index.js"}');
  await writeFile(join(pack, 'index.js'), 'module.exports=42;');
  execFileSync('tar', ['-czf', join(root, 'dep.tgz'), '-C', root, 'package']);
  const tar = await readFile(join(root, 'dep.tgz'));
  server.on('request', (req, res) => { assert.equal(req.headers.authorization, undefined); res.end(tar); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const project = join(root, 'project');
  execFileSync('git', ['init', '-q', '-b', 'main', project]);
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'fixture', private: true, dependencies: { 'fixture-dep': `http://127.0.0.1:${server.address().port}/dep.tgz` } }));
  await writeFile(join(project, '.gitignore'), 'node_modules/\n');
  await git(project, ['add', '.']);
  await git(project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture']);
  const data = join(root, 'data'); const validator = new CodexValidator(data); const signal = new AbortController().signal;
  const install = await validator.execute(project, { executable: 'pnpm', args: ['install', '--ignore-scripts', '--lockfile=false'] }, signal, 60000, false);
  assert.equal(install.exitCode, 0, install.output);
  await assert.rejects(access(join(project, '.pnpm-store')), 'install must not create a source-tree cache');
  const store = await validator.execute(project, { executable: 'pnpm', args: ['store', 'path'] }, signal, 15000, false);
  assert.equal(store.exitCode, 0, store.output);
  const runtime = await workspaceRuntime(data, project);
  assert.ok(store.output.trim().startsWith(join(runtime, 'package-cache/pnpm-store/')), store.output);
  await access(store.output.trim());
  const check = await validator.execute(project, { executable: 'node', args: ['-e', "require('node:assert/strict').equal(require('fixture-dep'),42);console.log('dependency works')"] }, signal, 15000, false);
  assert.equal(check.exitCode, 0, check.output);
  assert.equal(await git(project, ['status', '--porcelain']), '');
  console.log('PASS: sandboxed pnpm install keeps caches outside source, reuses the private store across calls, and leaves only ignored node_modules.');
} finally { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
