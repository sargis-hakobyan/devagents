import type { AgentDefinition, Task } from './schemas.js';

/** Old tasks retain the policy under which their plans were proposed and approved. */
export const taskRules = (task: Pick<Task, 'devagentsRules'>): boolean => task.devagentsRules ?? true;

/** Role scope and shell restrictions are optional; phase isolation is always enforced by the adapter. */
export function executionAgent(agent: AgentDefinition, rules: boolean): AgentDefinition {
  if (rules) return agent;
  return { ...agent, permissions: { readPaths: ['project:/**'], writePaths: agent.permissions.writePaths.length ? ['project:/**'] : [], allowCommands: true, allowPush: false } };
}

export function validationInstructions(rules: boolean): string {
  return rules
    ? 'Every validation command must use one of these supported forms only: node --test [test files], npm test, or npm run test/typecheck/lint/build. Inline scripts such as node -e, shell commands and other executables are unsupported.'
    : 'DevAgents extra rules are off. Inspect the project tooling and choose its actual validation commands (for example pnpm, yarn, npm scripts, or another installed executable). Provide executable and args separately; there is no implicit shell. Commands run in the coding engine sandbox without approval escalation or network access. Generated files may be written in the isolated worktree, but validation must not change the reviewed source files. Do not assume an executable or dependencies are installed.';
}
