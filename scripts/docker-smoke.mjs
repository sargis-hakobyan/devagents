import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { stringify } from 'yaml';

const exec = promisify(execFile);
const root = await realpath(await mkdtemp(join(tmpdir(), 'devagents-docker-')));
const projectName = `devagents-smoke-${process.pid}`;
const probe = createServer();
await new Promise(r => probe.listen(0, '127.0.0.1', r));
const port = probe.address().port;
await new Promise(r => probe.close(r));
const env = { ...process.env, DEVAGENTS_PORT: String(port) };
const override = join(root, 'compose.fixture.yaml');
const fixture = join(root, 'fixture');
const base = ['compose', '-p', projectName, '-f', resolve('compose.yaml'), '-f', override];
async function docker(args) {
  const result = await exec('docker', [...base, ...args], { env, timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
  return result.stdout.trim();
}
const cli = async (...args) => JSON.parse(await docker(['exec', '-T', 'devagents', 'node', 'dist/cli/main.js', ...args]));
try {
  await exec('git', ['init', '-q', '-b', 'main', fixture]);
  await writeFile(join(fixture, 'README.md'), '# Docker fixture\n');
  await exec('git', ['-C', fixture, 'add', '.']);
  await exec('git', ['-C', fixture, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Initial fixture']);
  await writeFile(override, stringify({ services: { devagents: { volumes: [{ type: 'bind', source: fixture, target: '/projects/fixture' }, { type: 'bind', source: resolve('scripts/vault-smoke.mjs'), target: '/app/scripts/vault-smoke.mjs', read_only: true }] } } }));
  console.log('Building and starting an isolated Docker smoke instance…');
  await docker(['up', '-d', '--build', '--wait', '--wait-timeout', '60']);
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
  const health = await cli('doctor');
  assert.equal(health.codexAuthenticated, false);
  assert.equal(health.engines.find(e => e.id === 'codex').installed, true);
  await cli('projects', 'add', 'fixture', '/projects/fixture');
  const task = await cli('tasks', 'submit', 'fixture', 'Persist across restart', '--key', 'docker-smoke');
  assert.equal(task.state, 'awaiting_mode');
  console.log(await docker(['exec', '-T', 'devagents', 'node', 'scripts/vault-smoke.mjs', 'create']));
  await docker(['restart']);
  await docker(['up', '-d', '--wait', '--wait-timeout', '60']);
  console.log(await docker(['exec', '-T', 'devagents', 'node', 'scripts/vault-smoke.mjs', 'restore']));
  const restored = await cli('tasks', 'show', task.id);
  assert.equal(restored.state, 'awaiting_mode');
  assert.equal((await cli('tasks', 'events', task.id)).length, 1);
  const retried = await cli('tasks', 'submit', 'fixture', 'Persist across restart', '--key', 'docker-smoke');
  assert.equal(retried.id, task.id);
  const id = await docker(['ps', '-q', 'devagents']);
  const inspect = JSON.parse((await exec('docker', ['inspect', id])).stdout)[0];
  assert.equal(inspect.Config.User, 'node');
  assert.equal(inspect.HostConfig.ReadonlyRootfs, true);
  assert.equal(inspect.Mounts.some(m => m.Destination === '/var/run/docker.sock'), false);
  await exec('docker', ['run', '--rm', '--read-only', '--tmpfs', '/tmp:size=128m,mode=1777', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--mount', `type=bind,source=${resolve('scripts/sandbox-spike.mjs')},target=/tmp/sandbox-spike.mjs,readonly`, 'devagents:local', 'node', '/tmp/sandbox-spike.mjs'], { timeout: 30000 });
  for (const script of ['auth-smoke.mjs', 'm2-smoke.mjs', 'codex-protocol-smoke.mjs']) {
    const result = await exec('docker', ['run', '--rm', '--read-only', '--tmpfs', '/tmp:size=128m,mode=1777', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--tmpfs', '/data:size=128m,mode=1777,exec', '-e', 'TMPDIR=/data', '--mount', `type=bind,source=${resolve('scripts', script)},target=/app/scripts/${script},readonly`, 'devagents:local', 'node', `/app/scripts/${script}`], { timeout: 90000, maxBuffer: 2 * 1024 * 1024 });
    console.log(result.stdout.trim());
  }
  console.log('PASS: Docker health, unauthenticated setup, explicit project mount, non-root execution, persistent task/event history and idempotent retry.');
  console.log('PASS: Docker command sandbox permits fixture workspace access and denies outside/credential paths.');
} finally {
  // Only resources created under this unique smoke-test project are removed.
  await docker(['down', '--volumes', '--remove-orphans']).catch(error => console.error(error.message));
  await rm(root, { recursive: true, force: true });
}
