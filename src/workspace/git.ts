import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { isWithin } from './paths.js';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { AppError } from '../domain/errors.js';
import { ProjectInput, type Project, type Task } from '../domain/schemas.js';
import { isOwnedBranch, itemBranch, ownedRefPatterns, taskBranch } from './branches.js';

const exec = promisify(execFile);
type Workspace = NonNullable<Task['workspace']>;
export async function git(cwd: string, args: string[], trim = true, maxBuffer = 2 * 1024 * 1024): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', '-c', 'submodule.recurse=false', '-c', `safe.directory=${cwd}`, '-c', 'protocol.file.allow=never', ...args], {
      cwd, timeout: 30000, maxBuffer,
      env: { PATH: process.env.PATH, HOME: homedir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1', GIT_LITERAL_PATHSPECS: '1', GIT_TERMINAL_PROMPT: '0' },
    }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new AppError('git_output_limit', `git ${args.find(a => !a.startsWith('-') && a !== 'core.hooksPath=/dev/null') ?? ''} output exceeded ${maxBuffer} bytes; the change or repository listing is too large for this version`);
    throw error;
  }
  return trim ? stdout.trim() : stdout;
}
async function mainCommit(path: string): Promise<string> {
  try { return await git(path, ['rev-parse', '--verify', 'refs/heads/main^{commit}']); }
  catch (error) {
    if ((error as { code?: unknown }).code === 128) throw new AppError('main_branch_missing', 'The project needs a local main branch before starting tasks. Create or update main from the intended upstream, then retry.');
    throw error;
  }
}
export async function inspectProject(input: unknown): Promise<Project> {
  const project = ProjectInput.parse(input);
  if (!isAbsolute(project.path)) throw new AppError('invalid_path', 'Provide an absolute project path');
  const path = await realpath(project.path).catch(() => { throw new AppError('invalid_path', 'Project path does not exist or is inaccessible to the service. In Docker, mount the checkout and register its container path.'); });
  if (path === parse(path).root || path === await realpath(homedir())) throw new AppError('invalid_path', 'Register a project directory, not a filesystem root or home directory');
  if (!(await stat(path)).isDirectory()) throw new AppError('invalid_path', 'Project must be a directory');
  const root = await git(path, ['rev-parse', '--show-toplevel']);
  if (await realpath(root) !== path) throw new AppError('invalid_path', 'Register the Git checkout root');
  const baseSha = await mainCommit(path);
  return { ...project, path, baseSha, registeredAt: new Date().toISOString() };
}
const creating = new Map<string, Promise<unknown>>();
export class WorkspaceManager {
  constructor(private readonly dataDir: string) {}
  /** Automatic retention never forces removal or deletes a branch. Unknown ignored files also keep a checkout alive. */
  async removeCleanCompleted(project: Project, taskId: string, workspaces: { path: string; branch: string }[], result: { branch: string; commit: string },
    beforeRemoval: (workspace: { path: string; branch: string }) => void, record: (workspace: { path: string; branch: string }) => void): Promise<void> {
    if (!/^[a-f0-9-]{36}$/.test(taskId) || !isOwnedBranch(result.branch, taskId) || !/^[a-f0-9]{40}$/.test(result.commit)) throw new AppError('cleanup_ownership', 'Invalid completed result');
    if (await realpath(project.path) !== project.path) throw new AppError('cleanup_ownership', 'Registered project path changed');
    const parent = join(await realpath(this.dataDir), 'worktrees');
    const common = await realpath(resolve(project.path, await git(project.path, ['rev-parse', '--git-common-dir'])));
    const verifyResult = async () => {
      if (await git(project.path, ['rev-parse', '--verify', `refs/heads/${result.branch}`]) !== result.commit) throw new AppError('cleanup_ownership', 'Reviewed result branch changed; keeping worktrees');
    };
    await verifyResult();
    for (const workspace of workspaces) {
      const { path, branch } = workspace;
      if (dirname(path) !== parent || !(basename(path) === taskId || basename(path).startsWith(`${taskId}-`)) || !isOwnedBranch(branch, taskId) || path === project.path) throw new AppError('cleanup_ownership', 'Worktree is not owned by the completed task');
      const entry = await lstat(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (!entry) continue;
      const verify = async () => {
        const current = await lstat(path);
        if (!current.isDirectory() || current.dev !== entry.dev || current.dev !== (await lstat(parent)).dev || current.ino !== entry.ino || await realpath(path) !== path || await realpath(parent) !== parent) throw new AppError('cleanup_ownership', 'Worktree path changed');
        const registry = (await git(project.path, ['worktree', 'list', '--porcelain', '-z'], false)).split('\0\0');
        if (!registry.some(row => row.split('\0').includes(`worktree ${path}`) && row.split('\0').includes(`branch refs/heads/${branch}`))) throw new AppError('cleanup_ownership', 'Worktree registration changed');
        if (await realpath(await git(path, ['rev-parse', '--show-toplevel'])) !== path || await realpath(resolve(path, await git(path, ['rev-parse', '--git-common-dir']))) !== common || await git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD']) !== branch) throw new AppError('cleanup_ownership', 'Worktree Git metadata changed');
        await verifyResult();
        // Sparse/assume-unchanged index flags can hide local edits from ordinary status.
        const flags = await git(path, ['ls-files', '-v', '-z'], false, 32 * 1024 * 1024);
        if (flags.split('\0').some(file => file && (file[0] === 'S' || /^[a-z]/.test(file)))) return false;
        return !(await git(path, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored', '--ignore-submodules=none'], false, 32 * 1024 * 1024));
      };
      if (!await verify()) continue;
      beforeRemoval(workspace);
      if (!await verify()) continue;
      await git(project.path, ['worktree', 'remove', path]);
      record(workspace);
    }
  }
  /** A fresh task branch from local main, independent of the user's checked-out branch and working files. */
  async create(project: Project, taskId: string, request: string): Promise<Workspace> {
    return this.createOwned(project, taskId, taskBranch(taskId, request));
  }
  /** A work-item worktree on `<task branch>-<item id>`, branched from the recorded integration base. */
  async createItem(project: Project, taskId: string, taskBranchName: string, itemId: string, baseSha: string): Promise<{ path: string; branch: string; baseSha: string }> {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(itemId) || !/^[a-f0-9]{40}$/.test(baseSha)) throw new AppError('invalid_work_item', 'Invalid work item or base commit');
    if (!isOwnedBranch(taskBranchName, taskId)) throw new AppError('branch_denied', 'Work items branch only from the managed task branch');
    return this.createOwned(project, taskId, itemBranch(taskBranchName, itemId), itemId, baseSha);
  }
  /**
   * Removes the managed worktrees of one task and deletes their branches, except branches named in
   * `keepBranches` (a completed task's branch holds the reviewed commit). Everything must be provably
   * ours: a registered worktree whose path sits under this data directory's worktrees folder and whose
   * name and branch carry the task ID. Anything else is refused rather than skipped.
   */
  async cleanup(project: Project, taskId: string, workspaces: { path: string; branch: string }[], keepBranches: ReadonlySet<string> = new Set()): Promise<{ removedWorktrees: string[]; removedBranches: string[]; keptBranches: string[] }> {
    if (!/^[a-f0-9-]{36}$/.test(taskId)) throw new AppError('invalid_task_id', 'Invalid worktree owner ID');
    if (await realpath(project.path) !== project.path) throw new AppError('path_denied', 'Registered project path changed');
    const parent = await realpath(resolve(this.dataDir, 'worktrees')).catch(() => undefined);
    const registered = new Set((await git(project.path, ['worktree', 'list', '--porcelain'], false)).split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice('worktree '.length)));
    const branches = new Set((await git(project.path, ['for-each-ref', '--format=%(refname:short)', ...ownedRefPatterns(taskId)])).split('\n').filter(b => isOwnedBranch(b, taskId)));
    const result = { removedWorktrees: [] as string[], removedBranches: [] as string[], keptBranches: [] as string[] };
    // Validate every entry before touching anything, so one refused entry leaves the task untouched.
    for (const workspace of workspaces) {
      const managed = parent !== undefined && isWithin(parent, workspace.path) && workspace.path !== parent && basename(workspace.path).startsWith(taskId) && isOwnedBranch(workspace.branch, taskId);
      if (!managed || workspace.path === project.path || isWithin(workspace.path, project.path)) throw new AppError('path_denied', `Refusing to remove ${workspace.path}: not a managed worktree of task ${taskId}`);
    }
    for (const workspace of workspaces) {
      if (registered.has(workspace.path)) { await git(project.path, ['worktree', 'remove', '--force', workspace.path]); result.removedWorktrees.push(workspace.path); }
      if (!branches.has(workspace.branch)) continue;
      if (keepBranches.has(workspace.branch)) result.keptBranches.push(workspace.branch);
      else { await git(project.path, ['branch', '-D', workspace.branch]); result.removedBranches.push(workspace.branch); }
    }
    // Drop stale registrations of worktree directories that no longer exist (crash between intent and creation).
    await git(project.path, ['worktree', 'prune']);
    return result;
  }
  /** Worktree creation is serialized per repository: parallel `git worktree add` calls contend on ref and metadata locks. */
  private async createOwned(project: Project, taskId: string, branch: string, itemId?: string, source?: string): Promise<Workspace> {
    const previous = creating.get(project.path) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.createNow(project, taskId, branch, itemId, source));
    creating.set(project.path, run);
    try { return await run; } finally { if (creating.get(project.path) === run) creating.delete(project.path); }
  }
  private async createNow(project: Project, taskId: string, branch: string, itemId?: string, source?: string): Promise<Workspace> {
    if (!/^[a-f0-9-]{36}$/.test(taskId)) throw new AppError('invalid_task_id', 'Invalid worktree owner ID');
    if (!isOwnedBranch(branch, taskId)) throw new AppError('branch_denied', 'Worktree branch is not owned by this task');
    // Revalidate registration immediately before accessing the project.
    if (await realpath(project.path) !== project.path) throw new AppError('path_denied', 'Registered project path changed');
    const configuration = await git(project.path, ['config', '--local', '--includes', '--name-only', '--list']);
    if (configuration.split('\n').some(key => key.startsWith('filter.'))) throw new AppError('unsafe_git_config', 'Worktree checkout with repository-defined filters requires sandbox support');
    // Resolve main at creation time, not registration time. Never fall back to HEAD or a previous task.
    const baseSha = source ?? await mainCommit(project.path);
    const originalHead = source === undefined ? await git(project.path, ['rev-parse', '--verify', 'HEAD']) : undefined;
    const parent = resolve(this.dataDir, 'worktrees');
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const owner = itemId ? `${taskId}-${itemId}` : taskId;
    const path = join(await realpath(parent), owner);
    await git(project.path, ['worktree', 'add', '-b', branch, path, baseSha]);
    return { path, branch, baseSha, ...(originalHead ? { originalHead } : {}) };
  }
}
