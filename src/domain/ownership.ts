import { AppError } from './errors.js';
import type { AgentDefinition } from './schemas.js';

function root(pattern: string): { path: string; tree: boolean } {
  const value = pattern.slice('project:/'.length);
  const path = value === '**' ? '' : value.endsWith('/**') ? value.slice(0, -3) : value;
  if (!pattern.startsWith('project:/') || /[?*\[\]{}\\]/.test(path) || path.split('/').some(p => p === '.' || p === '..')) throw new AppError('unsupported_policy', 'Ownership supports exact paths and subtree /** grants only');
  return { path, tree: value === '**' || value.endsWith('/**') };
}
export function covers(grant: string, requested: string): boolean {
  const g = root(grant); const r = root(requested);
  return g.tree ? g.path === '' || r.path === g.path || r.path.startsWith(`${g.path}/`) : !r.tree && r.path === g.path;
}
export function scopeAgent(agent: AgentDefinition, paths: string[]): AgentDefinition {
  if (!paths.length || paths.some(p => !agent.permissions.writePaths.some(g => covers(g, p)))) throw new AppError('ownership_denied', `Owned paths exceed ${agent.id}'s write permissions`);
  return { ...agent, permissions: { ...agent.permissions, writePaths: [...paths] } };
}
/**
 * The pinned Codex runtime cannot execute exact-file write grants under Linux bubblewrap. Plans are
 * checked against this rule before approval and the sandbox enforces it again at execution.
 * M4 should turn this into an engine capability rather than a platform switch.
 */
export function assertSupportedWriteGrant(pattern: string, platform: NodeJS.Platform): void {
  if (platform === 'linux' && !pattern.endsWith('/**')) throw new AppError('unsupported_policy', `Exact-file writes cannot be safely executed on this Linux runtime: ${pattern}. Use directory subtree write grants (project:/directory/**) and revise the plan scope instead of expanding it automatically.`);
}
