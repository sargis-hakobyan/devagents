import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const pnpmRoot = dirname(createRequire(import.meta.url).resolve('pnpm'));
export const pnpmCli = join(pnpmRoot, 'bin', 'pnpm.cjs');
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
/** A service-owned launcher makes the bundled, pinned pnpm available to validation and agents.
 * Never use a repository-supplied pnpm executable or auto-download another manager version.
 */
export async function nodeToolPath(temp: string): Promise<string> {
  const bin = join(temp, 'tools'); await mkdir(bin, { recursive: true, mode: 0o700 });
  await writeFile(join(bin, 'pnpm'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(pnpmCli)} --config.manage-package-manager-versions=false --ignore-pnpmfile "$@"\n`, { mode: 0o700 });
  return `${bin}:${process.env.PATH ?? ''}`;
}
