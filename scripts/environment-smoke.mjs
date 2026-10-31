import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify } from 'yaml';
import { NodeEnvironmentPreparer } from '../dist/workspace/environment.js';
import { CodexDependencyInstaller } from '../dist/engines/codex/preparation.js';
import { CodexValidator } from '../dist/engines/codex/validator.js';
import { git } from '../dist/workspace/git.js';

// Real package managers and sandbox, deterministic loopback tarball, no model/login or public registry.
const root = await mkdtemp(join(tmpdir(), 'devagents-environment-'));
const server = createServer(); let hits = 0;
try {
  const pack = join(root, 'tar/package'); await mkdir(pack, { recursive: true });
  await writeFile(join(pack, 'package.json'), JSON.stringify({ name: 'fixture-dep', version: '1.0.0', main: 'index.js', scripts: { postinstall: 'node -e "throw new Error(\'INSTALL SCRIPT MUST NOT RUN\')"' } }));
  await writeFile(join(pack, 'index.js'), 'module.exports = 42;');
  execFileSync('tar', ['-czf', join(root, 'dep.tgz'), '-C', join(root, 'tar'), 'package']);
  const tar = await readFile(join(root, 'dep.tgz'));
  const integrity = `sha512-${createHash('sha512').update(tar).digest('base64')}`;
  server.on('request', (req, res) => { hits++; assert.equal(req.headers.authorization, undefined); res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(tar); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/dep.tgz`;
  for (const manager of ['npm', 'pnpm']) {
    const project = join(root, manager); execFileSync('git', ['init', '-q', '-b', 'main', project]);
    await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', ...(manager === 'pnpm' ? { packageManager: 'pnpm@10.33.0' } : {}), dependencies: { 'fixture-dep': url, ...(manager === 'pnpm' ? { 'fixture-workspace': 'workspace:*' } : {}) }, scripts: { test: 'node test.cjs', postinstall: 'exit 99' } }));
    await writeFile(join(project, '.gitignore'), 'node_modules/\n');
    await writeFile(join(project, '.npmrc'), '//registry.npmjs.org/:_authToken=synthetic-do-not-read\n');
    await writeFile(join(project, '.pnpmfile.cjs'), 'throw new Error("HOOK MUST NOT RUN")');
    await writeFile(join(project, 'test.cjs'), `require('node:assert/strict').equal(require('fixture-dep'),42);${manager === 'pnpm' ? "require('node:assert/strict').equal(require('fixture-workspace'),7);" : ''}console.log('dependency works');`);
    if (manager === 'npm') await writeFile(join(project, 'package-lock.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'fixture', version: '1.0.0', dependencies: { 'fixture-dep': url } }, 'node_modules/fixture-dep': { version: '1.0.0', resolved: url, integrity, hasInstallScript: true } } }));
    else {
      await mkdir(join(project, 'packages/lib'), { recursive: true });
      await writeFile(join(project, 'packages/lib/package.json'), JSON.stringify({ name: 'fixture-workspace', version: '1.0.0', main: 'index.js' }));
      await writeFile(join(project, 'packages/lib/index.js'), 'module.exports = 7;');
      await writeFile(join(project, 'pnpm-workspace.yaml'), 'packages: ["packages/*"]\n');
      await writeFile(join(project, 'pnpm-lock.yaml'), stringify({ lockfileVersion: '9.0', settings: { autoInstallPeers: true, excludeLinksFromLockfile: false }, importers: { '.': { dependencies: { 'fixture-dep': { specifier: url, version: url }, 'fixture-workspace': { specifier: 'workspace:*', version: 'link:packages/lib' } } }, 'packages/lib': {} }, packages: { [`fixture-dep@${url}`]: { resolution: { integrity, tarball: url }, version: '1.0.0' } }, snapshots: { [`fixture-dep@${url}`]: {} } }));
    }
    await git(project, ['add', '.']); await git(project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid', 'commit', '-qm', 'Environment fixture']);
    const data = join(root, `data-${manager}`);
    const prep = new NodeEnvironmentPreparer(data, new CodexDependencyInstaller(data));
    const signal = new AbortController().signal;
    const commands = [{ executable: manager, args: ['test'] }];
    const events = [];
    await prep.prepare({ cwd: project, commands, signal, rules: false }, e => events.push(e));
    assert.equal(events.at(-1)?.state, 'ready');
    const validator = new CodexValidator(data);
    await validator.preflight(project, commands, signal, false);
    const result = await validator.execute(project, commands[0], signal, 30000, false);
    assert.equal(result.exitCode, 0, result.output); assert.match(result.output, /dependency works/);
    const failure = await validator.execute(project, { executable: 'node', args: ['-e', "console.log('visible failure evidence'); process.exitCode=7"] }, signal, 30000, false);
    assert.equal(failure.exitCode, 7); assert.match(failure.output, /visible failure evidence/);
    const beforeNetworkProbe = hits;
    const network = await validator.execute(project, { executable: 'node', args: ['-e', `fetch(${JSON.stringify(url)},{signal:AbortSignal.timeout(1000)}).then(()=>{process.exitCode=3},()=>console.log('network blocked'))`] }, signal, 10000, false);
    assert.equal(network.exitCode, 0, network.output); assert.match(network.output, /network blocked/); assert.equal(hits, beforeNetworkProbe);
    const before = hits; await prep.prepare({ cwd: project, commands, signal, rules: false }, () => {});
    assert.equal(hits, before, 'unchanged inputs reuse the prepared worktree');
    assert.equal(await git(project, ['status', '--porcelain']), '', 'setup changes no source, manifest, lockfile or Git metadata');
    await assert.rejects(validator.preflight(project, [{ executable: 'definitely-missing-runtime', args: [] }], signal, false), /Environment blocked/);
    await assert.rejects(access(join(project, 'INSTALL-SCRIPT-RAN')));
    console.log(`PASS: ${manager} locked dependency download, skipped hooks/scripts, isolated copy, usable validation and cached repeat.`);
  }
  assert.ok(hits >= 2);
} finally { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
