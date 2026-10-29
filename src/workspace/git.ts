import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { AppError } from '../domain/errors.js';
import { ProjectInput, type Project } from '../domain/schemas.js';

const exec = promisify(execFile);
export async function git(cwd: string, args: string[], trim = true): Promise<string> {
  const { stdout } = await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false', '-c', `safe.directory=${cwd}`, '-c', 'protocol.file.allow=never', ...args], {
    cwd, timeout: 30000, maxBuffer: 2 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: homedir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
  });
  return trim ? stdout.trim() : stdout;
}
export async function inspectProject(input: unknown): Promise<Project> {
  const project = ProjectInput.parse(input);
  if (!isAbsolute(project.path)) throw new AppError('invalid_path', 'Provide an absolute project path');
  const path = await realpath(project.path);
  if (path === parse(path).root || path === await realpath(homedir())) throw new AppError('invalid_path', 'Register a project directory, not a filesystem root or home directory');
  if (!(await stat(path)).isDirectory()) throw new AppError('invalid_path', 'Project must be a directory');
  const root = await git(path, ['rev-parse', '--show-toplevel']);
  if (await realpath(root) !== path) throw new AppError('invalid_path', 'Register the Git checkout root');
  const baseSha = await git(path, ['rev-parse', '--verify', 'HEAD']);
  return { ...project, path, baseSha, registeredAt: new Date().toISOString() };
}
export class WorkspaceManager {
  constructor(private readonly dataDir: string) {}
  async create(project: Project, taskId: string): Promise<{ path: string; branch: string; baseSha: string }> {
    if (!/^[a-f0-9-]{36}$/.test(taskId)) throw new AppError('invalid_task_id', 'Invalid worktree owner ID');
    // Revalidate registration immediately before accessing the project.
    if (await realpath(project.path) !== project.path) throw new AppError('path_denied', 'Registered project path changed');
    const configuration = await git(project.path, ['config', '--local', '--name-only', '--list']);
    if (configuration.split('\n').some(key => key.startsWith('filter.'))) throw new AppError('unsafe_git_config', 'Worktree checkout with repository-defined filters requires sandbox support');
    const parent = resolve(this.dataDir, 'worktrees');
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const path = join(await realpath(parent), taskId);
    const branch = `codex/devagents-${taskId}`;
    const baseSha = await git(project.path, ['rev-parse', '--verify', 'HEAD']);
    await git(project.path, ['worktree', 'add', '-b', branch, path, baseSha]);
    return { path, branch, baseSha };
  }
}
