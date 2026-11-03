import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** The caller supplies the canonical worktree path used when the runtime was created. */
export function workspaceRuntimePath(dataDir: string, canonicalCwd: string): string {
  return join(dataDir, 'workspace-runtimes', createHash('sha256').update(canonicalCwd).digest('hex'));
}
