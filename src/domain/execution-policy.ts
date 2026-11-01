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
    : 'DevAgents extra rules are off. Inspect the project tooling and choose its actual validation commands (for example pnpm, yarn, npm scripts, or another executable). Provide executable and args separately; there is no implicit shell. The coding engine sandbox permits network access, dependency installation and setup scripts in the task worktree and its dedicated HOME, without host privilege escalation. Setup runs after approval. Install persistent tools under $HOME/bin or $HOME/.local/bin (both on PATH); HOME survives later calls in this worktree. Generated files may be written, but validation must not change reviewed source files. Do not assume tooling or dependencies are already installed.';
}
