import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { git } from './git.js';
import { PolicyEngine } from '../domain/policy.js';
import { protectedPath } from '../engines/codex/sandbox.js';
import { AppError } from '../domain/errors.js';
import type { AgentDefinition, Project, Task } from '../domain/schemas.js';

export async function changes(workspace: NonNullable<Task['workspace']>, agent: AgentDefinition) {
  if (await realpath(workspace.path) !== workspace.path) throw new AppError('path_denied', 'Worktree path was replaced');
  if (await git(workspace.path, ['rev-parse', 'HEAD']) !== workspace.baseSha || await git(workspace.path, ['branch', '--show-current']) !== workspace.branch) throw new AppError('worktree_changed', 'Worktree HEAD or branch changed outside this task');
  const tracked = (await git(workspace.path, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', 'HEAD', '--'], false)).split('\0').filter(Boolean);
  const untracked = (await git(workspace.path, ['ls-files', '--others', '--exclude-standard', '-z'], false)).split('\0').filter(Boolean);
  const files = [...new Set([...tracked, ...untracked])].sort();
  const policy = new PolicyEngine(); const digest = createHash('sha256');
  const previews: string[] = [];
  for (const file of files) {
    if (protectedPath(file) || file === '.gitattributes' || file.endsWith('/.gitattributes')) throw new AppError('path_denied', `Changes to protected file ${file} are not permitted`);
    const path = await policy.file(agent, workspace.path, file, 'write');
    const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info && (!info.isFile() || info.nlink > 1 || info.size > 512 * 1024)) throw new AppError('unsupported_change', `Only regular text files up to 512KB can be committed: ${file}`);
    const content = info ? await readFile(path) : Buffer.from('[deleted]');
    if (content.includes(0)) throw new AppError('unsupported_change', 'Binary changes are not supported in this version');
    digest.update(file).update('\0').update(String(info?.mode)).update('\0').update(content);
    if (untracked.includes(file)) previews.push(`New file ${file}:\n${content.toString('utf8')}`);
  }
  const diff = await git(workspace.path, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', 'HEAD', '--'], false);
  const review = `${diff}\n${previews.join('\n')}`;
  if (review.length > 250000) throw new AppError('diff_limit', 'Diff exceeds review limit');
  return { files, digest: digest.digest('hex'), diff: review };
}
export async function commitChanges(project: Project, workspace: NonNullable<Task['workspace']>, files: string[]): Promise<string> {
  if (await git(project.path, ['rev-parse', 'HEAD']) !== workspace.baseSha) throw new AppError('base_diverged', 'Original project HEAD changed; inspect the worktree before integrating');
  return commitOwned(workspace, files, 'Implement reviewed DevAgents task');
}
export async function commitOwned(workspace: NonNullable<Task['workspace']>, files: string[], message: string): Promise<string> {
  if (!workspace.branch.startsWith('codex/devagents-')) throw new AppError('branch_denied', 'Commit is not on an owned branch');
  if (await git(workspace.path, ['rev-parse', 'HEAD']) !== workspace.baseSha || await git(workspace.path, ['branch', '--show-current']) !== workspace.branch) throw new AppError('worktree_changed', 'Worktree changed before commit');
  const config = await git(workspace.path, ['config', '--local', '--includes', '--name-only', '--list']);
  if (config.split('\n').some(k => k.startsWith('filter.'))) throw new AppError('unsafe_git_config', 'Git filters require additional isolation');
  if (files.length === 0) throw new AppError('no_changes', 'No changes to commit');
  await git(workspace.path, ['add', '--', ...files]);
  await git(workspace.path, ['-c', 'user.name=DevAgents', '-c', 'user.email=devagents@localhost', '-c', 'commit.gpgsign=false', 'commit', '-m', message]);
  return git(workspace.path, ['rev-parse', 'HEAD']);
}
