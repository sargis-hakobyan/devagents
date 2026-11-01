import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';

export const pnpmRoot = dirname(createRequire(import.meta.url).resolve('pnpm'));
export const pnpmCli = join(pnpmRoot, 'bin', 'pnpm.cjs');
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
/** Supply bundled pnpm; only extra-rules mode suppresses project hooks/version switching. */
export async function nodeToolPath(temp: string, rules = true, runtime?: string): Promise<string> {
  const bin = join(temp, 'tools'); await mkdir(bin, { recursive: true, mode: 0o700 });
  await writeFile(join(bin, 'pnpm'), `#!/bin/sh\nexec ${rules ? quote(process.execPath) : 'node'} ${quote(pnpmCli)} --config.package-import-method=copy ${rules ? '--config.manage-package-manager-versions=false --ignore-pnpmfile ' : ''}"$@"\n`, { mode: 0o700 });
  return [...(runtime ? [join(runtime, 'bin'), join(runtime, '.local/bin')] : []), bin, process.env.PATH ?? ''].join(':');
}

/** Secret-free, per-worktree HOME. Setup-installed tooling survives later engine/validation calls.
 * The sandbox grants the directory itself, never its parent or another task's environment.
 */
export async function workspaceRuntime(dataDir: string, cwd: string): Promise<string> {
  const id = createHash('sha256').update(await realpath(cwd)).digest('hex');
  const directory = join(dataDir, 'workspace-runtimes', id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return realpath(directory);
}
