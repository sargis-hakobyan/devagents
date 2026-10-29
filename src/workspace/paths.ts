import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { AppError } from '../domain/errors.js';

export function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
export async function scopedPath(root: string, path: string): Promise<string> {
  if (isAbsolute(path) || path.includes('\\') || path.includes('\0') || path.split('/').some(s => s === '..' || s === '.' || s === '.git' || s === '.devagents')) throw new AppError('path_denied', 'Unsafe project-relative path');
  const canonical = await realpath(root);
  const target = resolve(canonical, path);
  if (!isWithin(canonical, target)) throw new AppError('path_denied', 'Path is outside project');
  let current = canonical;
  for (const segment of relative(canonical, target).split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new AppError('path_denied', 'Symlinks are not allowed in scoped paths');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return target;
}
