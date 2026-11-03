import { createHash, createHmac, randomBytes } from 'node:crypto';
import { lstat, readdir, readlink, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { AppError } from '../domain/errors.js';
import type { Project } from '../domain/schemas.js';
import { isOwnedBranch } from './branches.js';
import { git } from './git.js';
import { workspaceRuntimePath } from './runtime.js';

const generated = new Set(['node_modules', '.pnpm-store']);
const maxEntries = 2_000_000;
const maxCandidates = 256;
const maxScanMs = 60_000;
type Workspace = { path: string; branch: string };
export type CompactionPreview = {
  taskId: string; digest: string; computedAt: string; expiresAt: string;
  candidates: { worktree: string; path: string; bytes: number; entries: number; kind?: 'dependencies' | 'tool-cache' | 'run-scratch' }[];
  reclaimableBytes: number;
  kept: string[];
};
type Scan = { preview: CompactionPreview; roots: { path: string; dev: number; ino: number }[] };

/** A preview is an expiring signed inventory, not authority supplied by the browser. */
export class WorktreeCompactor {
  private readonly key = randomBytes(32);
  constructor(private readonly dataDir: string) {}

  async preview(project: Project, taskId: string, workspaces: Workspace[], runIds: string[] = []): Promise<CompactionPreview> {
    return (await this.scan(project, taskId, workspaces, Date.now() + 10 * 60_000, runIds)).preview;
  }

  async compact(project: Project, taskId: string, workspaces: Workspace[], digest: string,
    beforeRemoval: (preview: CompactionPreview) => void, record: (result: { removed: string[]; status: 'completed' | 'partial' }) => void, runIds: string[] = []) {
    const expiry = Number(digest.split('.')[0]);
    if (!/^\d{13}\.[a-f0-9]{64}$/.test(digest) || !Number.isSafeInteger(expiry) || expiry <= Date.now() || expiry > Date.now() + 10 * 60_000) {
      throw new AppError('compaction_preview_stale', 'Preview expired or invalid; request a new compaction preview', 409);
    }
    const scan = await this.scan(project, taskId, workspaces, expiry, runIds);
    if (Date.now() >= expiry || scan.preview.digest !== digest) throw new AppError('compaction_preview_stale', 'Working files changed; request a new compaction preview', 409);
    // A durable intent is mandatory. Storage failure here leaves every directory untouched.
    beforeRemoval(scan.preview);
    const removed: string[] = [];
    try {
      for (const root of scan.roots) {
        // Service-owned writers are excluded by the lifecycle lease. Never follow a replaced parent.
        const current = await lstat(root.path);
        if (await realpath(root.path) !== root.path || !current.isDirectory() || current.dev !== root.dev || current.ino !== root.ino) throw new AppError('compaction_ownership', 'Generated directory changed during compaction', 409);
        await rm(root.path, { recursive: true, force: false }); removed.push(root.path);
      }
    } catch (error) {
      // Preserve the removal error even when reporting it also fails. The durable intent remains.
      try { record({ removed, status: 'partial' }); } catch { /* inspect the intent after storage recovery */ }
      throw error;
    }
    record({ removed, status: 'completed' });
    return { removed, estimatedReclaimedBytes: scan.preview.reclaimableBytes, kept: scan.preview.kept };
  }

  private async scan(project: Project, taskId: string, workspaces: Workspace[], expiry: number, runIds: string[]): Promise<Scan> {
    if (!/^[a-f0-9-]{36}$/.test(taskId) || workspaces.length > 64) throw new AppError('compaction_ownership', 'Invalid task worktree inventory', 409);
    if (await realpath(project.path) !== project.path) throw new AppError('compaction_ownership', 'Registered project path changed', 409);
    const dataRoot = await realpath(this.dataDir);
    const configuredParent = resolve(dataRoot, 'worktrees');
    const parent = await realpath(configuredParent).catch(error => { if (error.code === 'ENOENT') return configuredParent; throw error; });
    const common = await realpath(resolve(project.path, await git(project.path, ['rev-parse', '--git-common-dir'])));
    const registry = await git(project.path, ['worktree', 'list', '--porcelain', '-z'], false);
    const registered = new Map<string, string>(); let current = '';
    for (const field of registry.split('\0')) {
      if (field.startsWith('worktree ')) current = field.slice(9);
      if (field.startsWith('branch refs/heads/')) registered.set(current, field.slice(18));
    }
    const candidates: CompactionPreview['candidates'] = []; const roots: Scan['roots'] = [];
    const kept = ['Source files, staged edits, other untracked files, unknown ignored files in worktrees, branches and task/workflow history are kept.'];
    const fingerprint = createHash('sha256'); let visited = 0; const started = Date.now();
    const hash = (value: unknown) => fingerprint.update(JSON.stringify(value) + '\n');
    const visit = () => {
      if (++visited > maxEntries || Date.now() - started > maxScanMs) throw new AppError('compaction_inventory_too_large', 'Compaction inventory exceeds its scan budget; nothing was removed', 413);
    };
    // Metadata includes inode and ctime, so an ordinary same-size edit invalidates the preview.
    // Content is never read, and symlinks are recorded as links, never traversed.
    const measure = async (path: string, device: number, protectGit = true): Promise<{ bytes: number; entries: number }> => {
      visit(); const s = await lstat(path);
      if (s.dev !== device || (!s.isDirectory() && !s.isFile() && !s.isSymbolicLink())) throw new AppError('compaction_ownership', 'Mounts and special files cannot be compacted', 409);
      hash([path, s.dev, s.ino, s.mode, s.nlink, s.size, s.mtimeMs, s.ctimeMs, s.isSymbolicLink() ? await readlink(path) : null]);
      // Do not advertise shared hardlink blocks as exclusively reclaimable.
      let bytes = s.nlink > 1 && s.isFile() ? 0 : s.blocks * 512; let entries = 1;
      if (s.isDirectory()) for (const name of (await readdir(path)).sort()) {
        if (protectGit && name === '.git') throw new AppError('compaction_ownership', 'A generated directory contains Git metadata; preserve it for inspection', 409);
        const child = await measure(join(path, name), device, protectGit); bytes += child.bytes; entries += child.entries;
      }
      return { bytes, entries };
    };
    for (const workspace of [...workspaces].sort((a, b) => a.path.localeCompare(b.path))) {
      const { path, branch } = workspace;
      if (dirname(path) !== parent || !(basename(path) === taskId || basename(path).startsWith(`${taskId}-`)) || !isOwnedBranch(branch, taskId) || path === project.path) {
        throw new AppError('compaction_ownership', 'Workspace is not owned by this task', 409);
      }
      // A worktree's private tool HOME is regenerable, including after its worktree
      // was explicitly removed. Derive the identity; never accept a supplied cache path.
      const runtime = workspaceRuntimePath(dataRoot, path);
      const runtimeStat = await lstat(runtime).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (runtimeStat) {
        if (!runtimeStat.isDirectory() || await realpath(runtime) !== runtime || await realpath(dirname(runtime)) !== dirname(runtime)) throw new AppError('compaction_ownership', 'Task tool cache is an alias or mount', 409);
        const runtimeParent = await lstat(dirname(runtime));
        if (runtimeStat.dev !== runtimeParent.dev) throw new AppError('compaction_ownership', 'Task tool cache is a mount', 409);
        if (candidates.length >= maxCandidates) throw new AppError('compaction_inventory_too_large', 'Too many generated directories; nothing was removed', 413);
        const size = await measure(runtime, runtimeStat.dev, false);
        roots.push({ path: runtime, dev: runtimeStat.dev, ino: runtimeStat.ino });
        candidates.push({ worktree: dirname(runtime), path: basename(runtime), kind: 'tool-cache', ...size });
      } else hash([runtime, 'missing']);
      const s = await lstat(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (!s) { hash([path, branch, 'missing']); continue; }
      if (!s.isDirectory() || await realpath(path) !== path || registered.get(path) !== branch) throw new AppError('compaction_ownership', 'Workspace registration or path changed', 409);
      if (await realpath(resolve(path, await git(path, ['rev-parse', '--git-common-dir']))) !== common || await git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD']) !== branch || await realpath(await git(path, ['rev-parse', '--show-toplevel'])) !== path) {
        throw new AppError('compaction_ownership', 'Worktree Git metadata no longer matches its registration', 409);
      }
      hash([path, branch, await git(path, ['rev-parse', 'HEAD'])]);
      const index = await git(path, ['ls-files', '--stage', '-z'], false, 32 * 1024 * 1024);
      const headFiles = await git(path, ['ls-tree', '-r', '--name-only', '-z', 'HEAD'], false, 32 * 1024 * 1024);
      hash(index); hash(headFiles);
      const tracked = [...new Set([...headFiles.split('\0'), ...index.split('\0').filter(Boolean).map(line => line.slice(line.indexOf('\t') + 1))].filter(Boolean))];
      const trackedUnder = (p: string) => tracked.some(f => f === p || f.startsWith(`${p}/`));
      const ignoredEntries = (await git(path, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], false, 32 * 1024 * 1024)).split('\0').filter(Boolean).sort();
      for (const listed of ignoredEntries) {
        visit(); const rel = listed.replace(/\/$/, '');
        if (!generated.has(basename(rel))) continue;
        const full = join(path, rel); const entry = await lstat(full);
        if (!entry.isDirectory()) continue; // Never traverse root aliases into a shared dependency store.
        if (await realpath(full) !== full || entry.dev !== s.dev) throw new AppError('compaction_ownership', 'Generated directory is an alias or mount', 409);
        const visible = await git(path, ['ls-files', '--others', '--exclude-standard', '-z', '--', rel], false, 32 * 1024 * 1024);
        if (trackedUnder(rel) || visible) { kept.push(`${path}: ${rel} (contains tracked or non-ignored files)`); hash([full, 'kept']); continue; }
        if (candidates.length >= maxCandidates) throw new AppError('compaction_inventory_too_large', 'Too many generated directories; nothing was removed', 413);
        const size = await measure(full, s.dev);
        roots.push({ path: full, dev: entry.dev, ino: entry.ino }); candidates.push({ worktree: path, path: rel, kind: 'dependencies', ...size });
      }
    }
    // Legacy run scratch has no remaining role after a task drains. Ownership comes
    // from durable run-started evidence, never from matching arbitrary disk entries.
    for (const runId of [...new Set(runIds)].sort()) {
      if (!/^[a-f0-9-]{36}$/.test(runId)) throw new AppError('compaction_ownership', 'Invalid execution run ownership record', 409);
      const path = join(dataRoot, 'runs', runId);
      const entry = await lstat(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (!entry) { hash([path, 'missing']); continue; }
      if (!entry.isDirectory() || await realpath(path) !== path || await realpath(dirname(path)) !== dirname(path) || entry.dev !== (await lstat(dirname(path))).dev) throw new AppError('compaction_ownership', 'Run scratch is an alias or mount', 409);
      if (candidates.length >= maxCandidates) throw new AppError('compaction_inventory_too_large', 'Too many generated directories; nothing was removed', 413);
      const size = await measure(path, entry.dev, false);
      roots.push({ path, dev: entry.dev, ino: entry.ino });
      candidates.push({ worktree: dirname(path), path: runId, kind: 'run-scratch', ...size });
    }
    const inventory = fingerprint.digest('hex');
    const signature = createHmac('sha256', this.key).update(JSON.stringify({ taskId, expiry, inventory, candidates, kept })).digest('hex');
    return { roots, preview: { taskId, digest: `${expiry}.${signature}`, computedAt: new Date().toISOString(), expiresAt: new Date(expiry).toISOString(), candidates,
      reclaimableBytes: candidates.reduce((n, candidate) => n + candidate.bytes, 0), kept } };
  }
}
