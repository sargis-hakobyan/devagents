import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, link, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sandboxFlags } from '../../src/engines/codex/sandbox.js';

/** Parse the generated permission profile back into path → access, independent of flag ordering. */
async function profile(root: string, scanLimit?: number): Promise<Map<string, string>> {
  const temp = join(root, '..', 'temp'); await mkdir(temp, { recursive: true });
  const flags = await sandboxFlags(root, { readPaths: ['project:/**'], writePaths: ['project:/owned/**'], allowCommands: true, allowPush: false }, temp, scanLimit);
  const permissions = flags[flags.findIndex(f => f.startsWith('permissions=')) ]!;
  return new Map([...permissions.matchAll(/"((?:[^"\\]|\\.)*)"="(read|write|deny)"/g)].map(m => [JSON.parse(`"${m[1]}"`) as string, m[2]!]));
}

test('sandbox profile denies links and secrets, collapses fully-denied directories, and keeps mixed directories readable', async () => {
  const base = await mkdtemp(join(tmpdir(), 'sandbox-scan-')); const root = join(base, 'project'); await mkdir(root);
  const outside = join(base, 'outside-secret'); await writeFile(outside, 'fake');
  try {
    await writeFile(join(root, 'keep.txt'), 'ok'); await writeFile(join(root, '.env'), 'SECRET=1');
    await mkdir(join(root, 'owned')); await writeFile(join(root, 'owned', 'file.txt'), 'ok');
    await mkdir(join(root, 'links')); for (const name of ['a', 'b', 'c']) await symlink(outside, join(root, 'links', name));
    await mkdir(join(root, 'mixed')); await symlink(outside, join(root, 'mixed', 'link')); await writeFile(join(root, 'mixed', 'real.txt'), 'ok');
    await mkdir(join(root, 'hard')); await writeFile(join(root, 'hard', 'a.txt'), 'x'); await link(join(root, 'hard', 'a.txt'), join(root, 'hard', 'b.txt'));
    await mkdir(join(root, 'nested', 'bin'), { recursive: true }); await symlink(outside, join(root, 'nested', 'bin', 'tool'));
    await mkdir(join(root, 'empty'));
    const canonical = await realpath(root);
    const access = await profile(root);
    assert.equal(access.get(canonical), 'read');
    assert.equal(access.get(join(canonical, 'owned')), 'write');
    assert.equal(access.get(join(canonical, '.env')), 'deny');
    // Only-denied directories collapse to one deny; their entries are not listed individually.
    assert.equal(access.get(join(canonical, 'links')), 'deny');
    assert.equal(access.has(join(canonical, 'links', 'a')), false);
    assert.equal(access.get(join(canonical, 'hard')), 'deny');
    assert.equal(access.get(join(canonical, 'nested')), 'deny', 'a directory whose only child is a collapsed directory collapses too');
    assert.equal(access.has(join(canonical, 'nested', 'bin')), false);
    // Mixed directories stay readable; the link inside is denied on its own.
    assert.equal(access.has(join(canonical, 'mixed')), false);
    assert.equal(access.get(join(canonical, 'mixed', 'link')), 'deny');
    assert.equal(access.has(join(canonical, 'mixed', 'real.txt')), false);
    assert.equal(access.has(join(canonical, 'empty')), false);
    assert.equal(access.has(join(canonical, 'keep.txt')), false);
    // The scan limit is configurable, fails closed and tells the operator what to change.
    await assert.rejects(profile(root, 1000).then(() => profile(root, 5)), /scan limit of 5 entries.*workspaceScanLimit/);
  } finally { await rm(base, { recursive: true, force: true }); }
});
