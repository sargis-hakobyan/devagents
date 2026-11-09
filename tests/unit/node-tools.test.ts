import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { nodeToolPath, workspaceRuntime } from '../../src/engines/node-tools.js';
const exec = promisify(execFile);

test('pnpm uses a stable private cache outside source, including paths with spaces and quotes', async () => {
  const base = await mkdtemp(join(tmpdir(), "node-tools-'quoted "));
  try {
    const project = join(base, 'project'); await mkdir(project);
    await writeFile(join(project, 'package.json'), '{"name":"fixture","private":true}');
    // CLI cache flags take priority over repository configuration.
    await writeFile(join(project, 'pnpm-workspace.yaml'), 'storeDir: .pnpm-store\ncacheDir: .cache\n');
    const runtime = await workspaceRuntime(join(base, 'data'), project);
    await mkdir(join(runtime, 'bin'));
    await writeFile(join(runtime, 'bin/pnpm'), '#!/bin/sh\nexit 99\n', { mode: 0o700 });
    const stores: string[] = [];
    for (const run of ['setup', 'implementation', 'validation']) {
      const temp = join(base, run);
      const path = await nodeToolPath(temp, false, runtime);
      const executable = join(path.split(delimiter)[0]!, 'pnpm');
      const options = { cwd: project, env: { ...process.env, HOME: runtime, PATH: path, COREPACK_ENABLE_NETWORK: '0' } };
      const store = (await exec(executable, ['store', 'path'], options)).stdout.trim();
      assert.ok(store.startsWith(join(runtime, 'package-cache/pnpm-store/')), store);
      assert.equal((await exec(executable, ['config', 'get', 'cache-dir'], options)).stdout.trim(), join(runtime, 'package-cache/pnpm-cache'));
      stores.push(store);
      await assert.rejects(access(join(project, '.pnpm-store')));
    }
    assert.equal(new Set(stores).size, 1);
    const other = join(base, 'other'); await mkdir(other);
    assert.notEqual(await workspaceRuntime(join(base, 'data'), other), runtime);
    const strictTemp = join(base, 'strict');
    const strict = await nodeToolPath(strictTemp);
    const store = (await exec(join(strict.split(delimiter)[0]!, 'pnpm'), ['store', 'path'], { cwd: project, env: { ...process.env, HOME: strictTemp, PATH: strict } })).stdout.trim();
    assert.ok(store.startsWith(join(strictTemp, 'package-cache/pnpm-store/')), store);
  } finally { await rm(base, { recursive: true, force: true }); }
});
