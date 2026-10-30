import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { git } from './git.js';
import { AppError } from '../domain/errors.js';

/** Files on disk that review and commit never see: untracked paths excluded by the current ignore rules. */
export type HiddenSnapshot = Map<string, string>;

const list = async (cwd: string, args: string[]) => (await git(cwd, ['ls-files', ...args, '-z'], false, 64 * 1024 * 1024)).split('\0').filter(Boolean);

/**
 * Snapshot every untracked file the ignore rules currently hide, with a fingerprint the sandboxed
 * worker cannot forge: inode, size, mode and ctime (the kernel updates ctime on any content or
 * metadata change, and unprivileged processes cannot set it). Computed from `ls-files --others`
 * minus `ls-files --others --exclude-standard`, so edits to ignore rules count: a file that becomes
 * hidden after implementation is a new hidden file, a file that becomes visible is reviewed normally.
 */
export async function hiddenFiles(workspacePath: string): Promise<HiddenSnapshot> {
  const visible = new Set(await list(workspacePath, ['--others', '--exclude-standard']));
  const snapshot: HiddenSnapshot = new Map();
  for (const file of await list(workspacePath, ['--others'])) {
    if (visible.has(file)) continue;
    const info = await lstat(join(workspacePath, file), { bigint: true }).catch(() => null);
    snapshot.set(file, info ? `${info.ino}:${info.size}:${info.mode}:${info.ctimeNs}` : 'missing');
  }
  return snapshot;
}
/** Every hidden file must already have existed, unchanged, before the implementation call. */
export function assertHiddenUnchanged(before: HiddenSnapshot, after: HiddenSnapshot, subject: string): void {
  const changed = [...after].filter(([file, fingerprint]) => before.get(file) !== fingerprint).map(([file]) => `${before.has(file) ? 'modified' : 'created'} ${file}`);
  const removed = [...before.keys()].filter(file => !after.has(file)).map(file => `removed ${file}`);
  const problems = [...changed, ...removed];
  if (!problems.length) return;
  throw new AppError('hidden_changes', `${subject} changed ${problems.length} file(s) that review and the commit would not include because the ignore rules hide them: ${problems.slice(0, 20).join(', ')}${problems.length > 20 ? ', …' : ''}. Keep ignored, generated or dependency files out of the change, or make the files visible to review.`);
}
