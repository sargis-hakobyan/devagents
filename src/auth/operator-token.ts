import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';

export async function accessToken(dataDir: string): Promise<string> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  // A pre-existing, more permissive data directory is tightened on every start; the token inside is 0600.
  await chmod(dataDir, 0o700);
  const path = join(dataDir, 'api-token');
  try { await writeFile(path, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await chmod(path, 0o600);
  return (await readFile(path, 'utf8')).trim();
}
