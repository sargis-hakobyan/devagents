import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from './git.js';
import { changes } from './changes.js';
import type { AgentDefinition, Task } from '../domain/schemas.js';
import { AppError } from '../domain/errors.js';

type Workspace = NonNullable<Task['workspace']>;
export async function assertIntegrationConfig(path: string): Promise<void> {
  const config = await git(path, ['config', '--local', '--includes', '--name-only', '--list']);
  if (config.split('\n').some(k => k.startsWith('filter.') || /^merge\..*\.driver$/.test(k))) throw new AppError('unsafe_git_config', 'Integration cannot run repository-defined filters or merge drivers');
}
/** A private checkpoint for dependency worktrees, without advancing the task branch. */
export async function integrationSnapshot(workspace: Workspace, agent: AgentDefinition): Promise<string> {
  await assertIntegrationConfig(workspace.path);
  const current = await changes(workspace, agent);
  if (!current.files.length) return workspace.baseSha;
  await git(workspace.path, ['add', '--', ...current.files]);
  const tree = await git(workspace.path, ['write-tree']);
  return git(workspace.path, ['-c', 'user.name=DevAgents', '-c', 'user.email=devagents@localhost', '-c', 'commit.gpgsign=false', 'commit-tree', tree, '-p', workspace.baseSha, '-m', 'DevAgents dependency checkpoint (not final task approval)']);
}
export async function integrateItem(workspace: Workspace, source: Workspace, commit: string, agent: AgentDefinition): Promise<string[]> {
  await assertIntegrationConfig(workspace.path);
  await changes(workspace, agent);
  if (!/^[a-f0-9]{40}$/.test(commit) || await git(source.path, ['rev-parse', 'HEAD']) !== commit || await git(source.path, ['branch', '--show-current']) !== source.branch) throw new AppError('worktree_changed', 'Worker commit changed before integration');
  const patch = await git(source.path, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary', '--full-index', source.baseSha, commit, '--'], false);
  const directory = await mkdtemp(join(tmpdir(), 'devagents-patch-'));
  try {
    const file = join(directory, 'item.patch'); await writeFile(file, patch, { mode: 0o600 });
    try { await git(workspace.path, ['apply', '--3way', '--index', '--whitespace=nowarn', file]); }
    catch {
      const conflicts = (await git(workspace.path, ['diff', '--name-only', '--diff-filter=U', '-z'], false)).split('\0').filter(Boolean);
      if (!conflicts.length) throw new AppError('integration_failed', 'Worker patch could not be applied. Inspect the preserved item and integration worktrees.');
      return conflicts;
    }
    await changes(workspace, agent);
    return [];
  } finally { await rm(directory, { recursive: true, force: true }); }
}
