import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AppError } from '../domain/errors.js';
import type { Project, Task } from '../domain/schemas.js';
import { protectedPath } from '../domain/protected-paths.js';
import { environmentSecrets, redactValues } from '../telemetry/redact.js';
import { git } from './git.js';

export const diffLimits = { perFileBytes: 64 * 1024, totalBytes: 256 * 1024, files: 200, listingBytes: 256 * 1024, readBytes: 1024 * 1024 };
export type DiffFile = { path: string; added: number | null; removed: number | null; state: 'text' | 'binary' | 'truncated' | 'withheld'; text: string; shownBytes: number; bytes: number | null; redacted: boolean };
export type TaskDiff = { base: string; final: string; state: 'complete' | 'empty' | 'truncated'; limits: typeof diffLimits; files: DiffFile[] };
const unavailable = (message: string): never => { throw new AppError('diff_unavailable', message, 409); };
function prefix(text: string, budget: number): string { const b = Buffer.from(text); let end = Math.min(b.length, budget); while (end > 0 && end < b.length && (b[end]! & 0xc0) === 0x80) end--; return b.subarray(0, end).toString('utf8'); }
/** Reads immutable Git objects only, after checking the recorded task branch and base. No client paths/refs. */
export async function readTaskDiff(project: Project, task: Task, dataDir: string, secrets: readonly string[] = environmentSecrets()): Promise<TaskDiff> {
  const workspace = task.workspace; const final = task.outcome?.commit;
  if (task.state !== 'completed' || !workspace || !final) return unavailable('Diffs are offered only for completed tasks with a recorded final commit.');
  if (!/^[a-f0-9-]{36}$/.test(task.id) || workspace.branch !== `codex/devagents-${task.id}` || !/^[a-f0-9]{40}$/.test(workspace.baseSha) || !/^[a-f0-9]{40}$/.test(final)) return unavailable('Recorded commit or branch identity does not belong to this task.');
  try {
    const parent = await realpath(resolve(dataDir, 'worktrees'));
    if (workspace.path !== join(parent, task.id) || await realpath(project.path) !== project.path || await realpath(await git(project.path, ['rev-parse', '--show-toplevel'])) !== project.path) return unavailable('Recorded repository or worktree ownership changed.');
    const base = workspace.baseSha;
    const run = (args: string[], max = diffLimits.listingBytes) => git(project.path, ['--no-pager', '--no-replace-objects', ...args], false, max);
    if ((await run(['rev-parse', '--verify', `${base}^{commit}`])).trim() !== base || (await run(['rev-parse', '--verify', `${final}^{commit}`])).trim() !== final || (await run(['rev-parse', '--verify', `refs/heads/${workspace.branch}^{commit}`])).trim() !== final) return unavailable('Recorded commits are missing or the task branch no longer points to its final commit.');
    await run(['merge-base', '--is-ancestor', base, final]);
    const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--submodule=short'];
    const listing = (await run([...args, '--numstat', '-z', base, final, '--'])).split('\0').filter(Boolean);
    if (listing.length > diffLimits.files) return unavailable(`Diff file list exceeds ${diffLimits.files} files.`);
    let remaining = diffLimits.totalBytes;
    const files: DiffFile[] = [];
    for (const row of listing) {
      const first = row.indexOf('\t'), second = row.indexOf('\t', first + 1);
      const added = row.slice(0, first), removed = row.slice(first + 1, second), path = row.slice(second + 1);
      if (first < 0 || second < 0 || !path || path.startsWith('/') || path.split('/').includes('..') || !/^(\d+|-)$/.test(added) || !/^(\d+|-)$/.test(removed)) return unavailable('Git returned an unsupported file listing.');
      const file: DiffFile = { path: redactValues(path, secrets) as string, added: added === '-' ? null : Number(added), removed: removed === '-' ? null : Number(removed), state: 'text', text: '', shownBytes: 0, bytes: null, redacted: false };
      if (protectedPath(path)) file.state = 'withheld';
      else if (added === '-' || removed === '-') file.state = 'binary';
      else if (remaining <= 0) file.state = 'truncated';
      else {
        try {
          // Read to a larger finite cap, redact complete values BEFORE display truncation. If that
          // cap is exceeded, omit the text entirely: a partial captured secret must never escape.
          const raw = await run([...args, '--patch', '--unified=3', base, final, '--', path], diffLimits.readBytes);
          const safe = redactValues(raw, secrets) as string; file.redacted = safe !== raw;
          file.bytes = Buffer.byteLength(safe); file.text = prefix(safe, Math.min(remaining, diffLimits.perFileBytes));
          file.shownBytes = Buffer.byteLength(file.text); remaining -= file.shownBytes;
          if (file.shownBytes < file.bytes) file.state = 'truncated';
        } catch (e) { if (e instanceof AppError && e.code === 'git_output_limit') file.state = 'truncated'; else throw e; }
      }
      files.push(file);
    }
    return { base, final, state: files.some(f => f.state === 'truncated') ? 'truncated' : files.length ? 'complete' : 'empty', limits: diffLimits, files };
  } catch (e) {
    if (e instanceof AppError && e.code === 'diff_unavailable') throw e;
    return unavailable(e instanceof AppError && e.code === 'git_output_limit' ? 'Diff file list exceeds the bounded listing size.' : 'Recorded repository, commits or task branch are unavailable or do not share the recorded base.');
  }
}
