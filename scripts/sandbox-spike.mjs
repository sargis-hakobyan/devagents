import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);
const root = await realpath(await mkdtemp(join(tmpdir(), 'devagents-sandbox-')));
const home = join(root, 'runtime'); const workspace = join(root, 'workspace');
const outside = join(root, 'outside');
try {
  for (const path of [home, workspace, outside]) await mkdir(path);
  await mkdir(join(workspace, '.git'));
  await writeFile(join(outside, 'sentinel'), 'not-a-real-secret');
  await writeFile(join(workspace, '.env'), 'not-a-real-secret');
  await writeFile(join(workspace, 'allowed.txt'), 'allowed');
  await writeFile(join(home, 'config.toml'), `default_permissions = "devagents"\n[permissions.devagents.filesystem]\n":minimal" = "read"\n[permissions.devagents.filesystem.":workspace_roots"]\n"." = "write"\n".env" = "deny"\n".git" = "deny"\n[permissions.devagents.network]\nenabled = false\n`);
  const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: home };
  const sandbox = args => exec('codex', ['sandbox', '-C', workspace, '-P', 'devagents', '--', ...args], { cwd: workspace, env, timeout: 10000 });
  const read = await sandbox(['/bin/cat', join(workspace, 'allowed.txt')]);
  assert.equal(read.stdout.trim(), 'allowed');
  await sandbox(['/usr/bin/touch', join(workspace, 'created.txt')]);
  await assert.rejects(sandbox(['/bin/cat', join(outside, 'sentinel')]));
  await assert.rejects(sandbox(['/bin/cat', join(workspace, '.env')]));
  await assert.rejects(sandbox(['/usr/bin/touch', join(outside, 'created.txt')]));
  console.log('PASS: workspace reads/writes allowed; outside reads/writes and project .env reads denied.');
} finally { await rm(root, { recursive: true, force: true }); }
