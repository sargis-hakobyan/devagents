import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { AppError } from '../domain/errors.js';
import type { Project } from '../domain/schemas.js';
import { isOwnedBranch } from './branches.js';
import { git } from './git.js';
import { assertDiskSpace, DATABASE_HEADROOM } from './disk-space.js';
import { withRepositoryLock } from './repository-lock.js';

const exec = promisify(execFile);
type Workspace = { path: string; branch: string };
export type CleanupRecord = Workspace & { head: string; recoveryPath?: string };
const refused = (message: string) => new AppError('cleanup_ownership', message, 409);

/** Run only under a terminal task's maintenance lease, after every worker has drained. */
export async function cleanupTerminalWorktrees(dataDir: string, project: Project, taskId: string, workspaces: Workspace[],
  intent: (record: CleanupRecord) => void, completed: (record: CleanupRecord) => void): Promise<void> {
  if (!/^[a-f0-9-]{36}$/.test(taskId) || workspaces.length > 64) throw refused('Invalid task worktree inventory');
  if (await realpath(project.path) !== project.path) throw refused('Registered project path changed');
  const root = await realpath(dataDir); const parent = join(root, 'worktrees');
  const common = await realpath(resolve(project.path, await git(project.path, ['rev-parse', '--git-common-dir'])));
  for (const workspace of workspaces) {
    const { path, branch } = workspace;
    if (dirname(path) !== parent || !(basename(path) === taskId || basename(path).startsWith(`${taskId}-`)) || !isOwnedBranch(branch, taskId) || path === project.path) throw refused('Worktree is not owned by this task');
    const initial = await lstat(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (!initial) continue;
    const verify = async () => {
      const s = await lstat(path);
      if (!s.isDirectory() || s.ino !== initial.ino || s.dev !== initial.dev || s.dev !== (await lstat(parent)).dev || await realpath(path) !== path || await realpath(parent) !== parent) throw refused('Worktree path changed or is a mount');
      const registry = (await git(project.path, ['worktree', 'list', '--porcelain', '-z'], false)).split('\0\0');
      if (!registry.some(row => row.split('\0').includes(`worktree ${path}`) && row.split('\0').includes(`branch refs/heads/${branch}`))) throw refused('Worktree registration changed');
      if (await realpath(await git(path, ['rev-parse', '--show-toplevel'])) !== path || await realpath(resolve(path, await git(path, ['rev-parse', '--git-common-dir']))) !== common || await git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD']) !== branch) throw refused('Worktree Git metadata changed');
      return git(path, ['rev-parse', 'HEAD']);
    };
    const head = await verify();
    // Include hidden edits and index-only content in the snapshot decision. A clean status alone
    // cannot prove cleanliness when assume-unchanged or sparse index flags are present.
    const index = await git(path, ['ls-files', '--stage', '-z'], false, 32 * 1024 ** 2);
    const flags = await git(path, ['ls-files', '-v', '-z'], false, 32 * 1024 ** 2);
    const status = await git(path, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored', '--ignore-submodules=none'], false, 32 * 1024 ** 2);
    const dirty = Boolean(status || flags.split('\0').some(f => f && (f[0] === 'S' || /^[a-z]/.test(f))));
    const before = await inventory(path, initial.dev);
    let recoveryPath: string | undefined;
    if (dirty) {
      // Budget the uncompressed files plus metadata before creating a snapshot. Maintenance
      // must not consume the database headroom it is trying to recover.
      await assertDiskSpace(root, DATABASE_HEADROOM + before.bytes + 256 * 1024 ** 2);
      const recoveryRoot = join(root, 'recovery');
      await mkdir(recoveryRoot, { recursive: true, mode: 0o700 });
      if (await realpath(recoveryRoot) !== recoveryRoot || (await lstat(recoveryRoot)).dev !== (await lstat(root)).dev) throw refused('Recovery directory is an alias or mount');
      recoveryPath = await mkdtemp(join(recoveryRoot, `${basename(path)}-`));
      try {
        // Private archive, not a Git commit: ignored files can contain private local material.
        // tar never dereferences symlinks; inventory rejects mounts, special files and nested Git.
        await exec('tar', ['--exclude=./.git', '-czf', join(recoveryPath, 'workspace.tar.gz'), '-C', path, '.'], { timeout: 120000, maxBuffer: 1024 ** 2 });
        await exec('tar', ['-tzf', join(recoveryPath, 'workspace.tar.gz')], { timeout: 120000, maxBuffer: 32 * 1024 ** 2 });
        // Preserve staged-only blobs too (including a staged edit later overwritten in the checkout).
        const staged = await git(path, ['diff', '--cached', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', 'HEAD'], false, 32 * 1024 ** 2);
        await writeFile(join(recoveryPath, 'staged.patch'), staged, { mode: 0o600, flag: 'wx' });
        const conflicts = [...new Set(index.split('\0').flatMap(entry => {
          const match = /^\d+ ([a-f0-9]{40}) ([123])\t/.exec(entry); return match ? [match[1]!] : [];
        }))];
        if (conflicts.length) {
          const blobs = join(recoveryPath, 'conflict-blobs'); await mkdir(blobs, { mode: 0o700 });
          for (const oid of conflicts) {
            const { stdout } = await exec('git', ['--no-replace-objects', '-c', `safe.directory=${path}`, 'cat-file', 'blob', oid], {
              cwd: path, encoding: 'buffer', timeout: 30000, maxBuffer: 32 * 1024 ** 2,
              env: { PATH: process.env.PATH, HOME: homedir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
            });
            const file = await open(join(blobs, oid), 'wx', 0o600);
            try { await file.writeFile(stdout); await file.sync(); } finally { await file.close(); }
          }
          const handle = await open(blobs, 'r'); try { await handle.sync(); } finally { await handle.close(); }
        }
        await writeFile(join(recoveryPath, 'manifest.json'), JSON.stringify({ taskId, ...workspace, head, createdAt: new Date().toISOString(), index, flags,
          restore: 'Extract workspace.tar.gz into an empty directory to inspect the remaining working files, including ignored files and deletions by absence. For staged changes, create a separate worktree from head and apply staged.patch with git apply --cached. Unmerged index stages are listed in index, with their raw content in conflict-blobs. Generated dependencies were compacted first.' }, null, 2), { mode: 0o600, flag: 'wx' });
        for (const name of ['workspace.tar.gz', 'staged.patch', 'manifest.json']) {
          const file = await open(join(recoveryPath, name), constants.O_RDONLY | constants.O_NOFOLLOW);
          try { await file.chmod(0o600); await file.sync(); } finally { await file.close(); }
        }
        for (const dir of [recoveryPath, recoveryRoot]) {
          const handle = await open(dir, 'r'); try { await handle.sync(); } finally { await handle.close(); }
        }
      } catch (error) { await rm(recoveryPath, { recursive: true, force: true }); throw error; }
    }
    const record = { ...workspace, head, ...(recoveryPath ? { recoveryPath } : {}) };
    // Persist the recovery location before removal. If storage fails, leave the original intact.
    try { intent(record); }
    catch (error) {
      // The original is untouched and no durable reference exists. Do not accumulate duplicate
      // archives when a full database repeatedly refuses the intent.
      if (recoveryPath) await rm(recoveryPath, { recursive: true, force: true });
      throw error;
    }
    // Archive creation is outside the shared lock; only final verification/removal owns Git metadata.
    await withRepositoryLock(common, async () => {
      if (await verify() !== head || (await inventory(path, initial.dev)).digest !== before.digest || await git(path, ['ls-files', '--stage', '-z'], false, 32 * 1024 ** 2) !== index || await git(path, ['ls-files', '-v', '-z'], false, 32 * 1024 ** 2) !== flags) throw refused('Worktree changed during cleanup; keeping the checkout and recovery snapshot');
      await git(project.path, ['worktree', 'remove', ...(dirty ? ['--force'] : []), path], true, 2 * 1024 ** 2, { timeoutMs: 120000 });
      completed(record); // All branches remain; only the disposable checkout is removed.
    });
  }
}

async function inventory(root: string, device: number): Promise<{ digest: string; bytes: number }> {
  const digest = createHash('sha256'); let bytes = 0; let entries = 0; const started = Date.now();
  const visit = async (path: string): Promise<void> => {
    if (++entries > 200000 || Date.now() - started > 60000) throw refused('Recovery inventory exceeds its safety budget; keeping the checkout');
    const s = await lstat(path);
    if (s.dev !== device || (!s.isDirectory() && !s.isFile() && !s.isSymbolicLink())) throw refused('Worktree contains a mount or special file; keeping it for inspection');
    if (s.isFile()) bytes += s.size;
    digest.update(JSON.stringify([path, s.ino, s.dev, s.mode, s.size, s.mtimeMs, s.ctimeMs, s.isSymbolicLink() ? await readlink(path) : null]));
    if (s.isDirectory()) for (const name of (await readdir(path)).sort()) {
      if (name === '.git') { if (path === root) continue; throw refused('Worktree contains nested Git metadata; keeping it for inspection'); }
      await visit(join(path, name));
    }
  };
  await visit(root); return { digest: digest.digest('hex'), bytes };
}
