/**
 * The single list of path segments and suffixes that no agent may read, write or commit through
 * DevAgents: credentials, runtime configuration and Git metadata. Used by the policy engine, the
 * change detector, the planner's file listing and the Codex sandbox so the rules cannot drift.
 */
export const deniedSegments = ['.git', '.devagents', '.codex', '.claude', '.agents', '.ssh', '.aws', '.env', '.npmrc', '.netrc', '.mcp.json'];
export function protectedPath(path: string): boolean {
  return path.split('/').some(p => deniedSegments.includes(p) || p.startsWith('.env.')) || /\.(pem|key)$/i.test(path);
}
