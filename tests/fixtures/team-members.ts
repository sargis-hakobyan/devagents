import { MemberInput, type TeamMember } from '../../src/domain/schemas.js';

/** Minimal custom members for team tests; templates come from the registry via `service.templates()`. */
export const member = (overrides: Partial<TeamMember> & { id: string }): TeamMember => MemberInput.parse({
  name: overrides.id, description: `Role ${overrides.id}`, instructions: `# ${overrides.id}`, capabilities: ['implementation', 'filesystem-write'],
  delegation: { canReceiveTasks: true, canDelegate: false }, permissions: { readPaths: ['project:/**'], writePaths: ['project:/**'], allowCommands: false }, ...overrides,
});
export const lead = () => member({ id: 'lead', capabilities: ['planning', 'filesystem-read'], delegation: { canReceiveTasks: false, canDelegate: true }, permissions: { readPaths: ['project:/**'], writePaths: [], allowCommands: true, allowPush: false } });
export const reviewer = () => member({ id: 'reviewer', capabilities: ['review', 'filesystem-read'], permissions: { readPaths: ['project:/**'], writePaths: [], allowCommands: false, allowPush: false } });
export const developer = () => member({ id: 'dev' });
