import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { isWithin } from './paths.js';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, parse, resolve } from 'node:path';
import { AppError } from '../domain/errors.js';
import { ProjectInput, type Project } from '../domain/schemas.js';

const exec = promisify(execFile);
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
export async function inspectProject(input: unknown): Promise<Project> {
  const project = ProjectInput.parse(input);
  if (!isAbsolute(project.path)) throw new AppError('invalid_path', 'Provide an absolute project path');
  const path = await realpath(project.path).catch(() => { throw new AppError('invalid_path', 'Project path does not exist or is inaccessible to the service. In Docker, mount the checkout and register its container path.'); });
  if (path === parse(path).root || path === await realpath(homedir())) throw new AppError('invalid_path', 'Register a project directory, not a filesystem root or home directory');
  if (!(await stat(path)).isDirectory()) throw new AppError('invalid_path', 'Project must be a directory');
  const root = await git(path, ['rev-parse', '--show-toplevel']);
  if (await realpath(root) !== path) throw new AppError('invalid_path', 'Register the Git checkout root');
  const baseSha = await git(path, ['rev-parse', '--verify', 'HEAD']);
  return { ...project, path, baseSha, registeredAt: new Date().toISOString() };
}
const creating = new Map<string, Promise<unknown>>();
export class WorkspaceManager {
  constructor(private readonly dataDir: string) {}
  async create(project: Project, taskId: string): Promise<{ path: string; branch: string; baseSha: string }> {
    return this.createOwned(project, taskId);
  }
  async createItem(project: Project, taskId: string, itemId: string, baseSha: string): Promise<{ path: string; branch: string; baseSha: string }> {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(itemId) || !/^[a-f0-9]{40}$/.test(baseSha)) throw new AppError('invalid_work_item', 'Invalid work item or base commit');
    return this.createOwned(project, taskId, itemId, baseSha);
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
    const branches = new Set((await git(project.path, ['for-each-ref', '--format=%(refname:short)', `refs/heads/codex/devagents-${taskId}`, `refs/heads/codex/devagents-${taskId}-*`])).split('\n').filter(Boolean));
    const result = { removedWorktrees: [] as string[], removedBranches: [] as string[], keptBranches: [] as string[] };
    // Validate every entry before touching anything, so one refused entry leaves the task untouched.
    for (const workspace of workspaces) {
      const managed = parent !== undefined && isWithin(parent, workspace.path) && workspace.path !== parent && basename(workspace.path).startsWith(taskId) && workspace.branch.startsWith(`codex/devagents-${taskId}`);
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
  private async createOwned(project: Project, taskId: string, itemId?: string, source?: string): Promise<{ path: string; branch: string; baseSha: string }> {
    const previous = creating.get(project.path) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.createNow(project, taskId, itemId, source));
    creating.set(project.path, run);
    try { return await run; } finally { if (creating.get(project.path) === run) creating.delete(project.path); }
  }
  private async createNow(project: Project, taskId: string, itemId?: string, source?: string): Promise<{ path: string; branch: string; baseSha: string }> {
    if (!/^[a-f0-9-]{36}$/.test(taskId)) throw new AppError('invalid_task_id', 'Invalid worktree owner ID');
    // Revalidate registration immediately before accessing the project.
    if (await realpath(project.path) !== project.path) throw new AppError('path_denied', 'Registered project path changed');
    const configuration = await git(project.path, ['config', '--local', '--includes', '--name-only', '--list']);
    if (configuration.split('\n').some(key => key.startsWith('filter.'))) throw new AppError('unsafe_git_config', 'Worktree checkout with repository-defined filters requires sandbox support');
    const parent = resolve(this.dataDir, 'worktrees');
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const owner = itemId ? `${taskId}-${itemId}` : taskId;
    const path = join(await realpath(parent), owner);
    const branch = `codex/devagents-${owner}`;
    const baseSha = source ?? await git(project.path, ['rev-parse', '--verify', 'HEAD']);
    await git(project.path, ['worktree', 'add', '-b', branch, path, baseSha]);
    return { path, branch, baseSha };
  }
}
