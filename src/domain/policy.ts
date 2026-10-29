import { matchesGlob } from 'node:path';
import { AppError } from './errors.js';
import type { AgentDefinition } from './schemas.js';
import { scopedPath } from '../workspace/paths.js';

export class PolicyEngine {
  async file(agent: AgentDefinition, root: string, path: string, action: 'read' | 'write'): Promise<string> {
    const target = await scopedPath(root, path);
    // Credentials and runtime configuration are never agent-editable/readable through our tools.
    if (path.split('/').some(p => /^\.env(?:\.|$)/.test(p) || ['.ssh', '.aws', '.codex', '.claude'].includes(p)) || /\.(?:pem|key)$/.test(path)) throw new AppError('path_denied', 'Secret or runtime configuration path denied');
    const allow = action === 'read' ? agent.permissions.readPaths : agent.permissions.writePaths;
    if (!allow.some(pattern => matchesGlob(path, pattern.slice('project:/'.length)))) throw new AppError('permission_denied', `${agent.id} cannot ${action} that path`, 403);
    return target;
  }
  external(action: 'push' | 'merge' | 'deploy'): never {
    throw new AppError('permission_denied', `${action} is not enabled in this milestone`, 403);
  }
  command(): never {
    // A shell allowlist alone cannot contain scripts, interpreters, or child processes.
    throw new AppError('sandbox_required', 'Command execution requires a verified execution sandbox', 403);
  }
}
