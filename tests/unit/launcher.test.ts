import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
const exec = promisify(execFile);

test('launcher builds once, reuses unchanged images, offers browser setup without auth and rebuilds changed sources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'launcher-')); const bin = join(root, 'bin'); const log = join(root, 'calls');
  try {
    for (const dir of ['bin', 'scripts', 'src', 'ui', 'agents']) await mkdir(join(root, dir));
    await copyFile(resolve('devagents'), join(root, 'devagents'));
    for (const file of ['Dockerfile', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json']) await writeFile(join(root, file), 'fixture');
    await writeFile(join(root, 'scripts/vault-key.sh'), '#!/bin/sh\nprintf "%064d" 0\n', { mode: 0o700 });
    await writeFile(join(bin, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> "$FIXTURE_LOG"
case "$*" in
 *'auth vault-exists'*) echo no ;;
 *'auth unlock'*) cat >/dev/null; echo unlocked ;;
 *setup-status*) echo needed ;;
 *'main.js ui'*) echo 'http://127.0.0.1:4310/ui/login?code=fixture&next=setup' ;;
esac
`, { mode: 0o700 });
    for (const cmd of ['open', 'xdg-open']) await writeFile(join(bin, cmd), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FIXTURE_LOG"\n', { mode: 0o700 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE_LOG: log };
    const run = (...args: string[]) => exec('sh', [join(root, 'devagents'), ...args], { env });
    const first = await run('start', '--later'); assert.match(first.stdout, /Continue setup: http/);
    await run('start', '--browser');
    let calls = await readFile(log, 'utf8'); assert.equal(calls.split('\n').filter(l => l.includes('up -d --build')).length, 1);
    assert.match(calls, /http:\/\/127.0.0.1:4310\/ui\/login/); assert.doesNotMatch(calls, /auth setup/);
    await writeFile(join(root, 'src/new.ts'), '// changed'); await run('start', '--later');
    calls = await readFile(log, 'utf8'); assert.equal(calls.split('\n').filter(l => l.includes('up -d --build')).length, 2);
    await assert.rejects(run('setup', '--browser', '--test-connection'), /require --terminal/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
