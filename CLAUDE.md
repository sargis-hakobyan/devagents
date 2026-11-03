# CLAUDE.md - DevAgents Assistant Context

Guidance for Claude Code working in DevAgents. Read the root `AGENTS.md` before
investigating or changing this repository; it contains the shared behavioral,
security, development, verification and UI rules. Read applicable nested
instruction files before working in their directories.

Keep shared rules in `AGENTS.md` so Codex and Claude follow the same conventions.
This companion provides a brief orientation, not a separate set of project rules.

## Defaults

- State material assumptions before changing code. Ask when unresolved requirements affect product behavior or scope; use judgment for routine implementation choices.
- Prefer small, surgical changes. Preserve existing staged, unstaged and untracked work.
- Explanation and proposal requests do not authorize implementation.
- Never commit plaintext secrets, credentials, login state or task databases. Use placeholders in examples and preserve credential-vault and redaction protections.
- Verify the requested outcome with relevant checks and report any gaps. Use the commands in `AGENTS.md`; documentation-only changes do not need the application test suite.
- Use deterministic fixtures by default. Live model tests and authenticated connection checks require authorization for the current task.

## Git

- Stay on the current branch, including `main`. Create or switch branches only when explicitly requested.
- Local commits are allowed; stage only the intended files and inspect the staged diff first.
- Use short, specific, imperative commit subjects without agent-name prefixes.
- Push only when explicitly requested for the current work. Earlier push permission does not authorize a later push.
- These contributor rules do not change the isolated task branches created by DevAgents itself.

## Repository Shape

- `src/domain/` defines schemas, lifecycle, plans and policies.
- `src/orchestration/` implements Mastra workflows, DAG execution, validation and review.
- `src/engines/` provides coding-engine adapters, sandboxing and environment preparation.
- `src/workspace/` manages Git worktrees, integration, diffs and cleanup.
- `src/persistence/` stores durable task state and evidence.
- `src/api/` and `src/cli/` expose HTTP/browser and terminal workflows.
- `src/security/` and `src/setup/` handle credentials and authentication setup.
- `agents/builtin/` contains YAML agent definitions and Markdown instructions.
- `ui/src/` contains the Preact/Vite frontend and local CSS.
- `tests/` and `scripts/` contain tests, deterministic fixtures and smoke checks.

## Project References

- Use `README.md`, `docs/SETUP.md` and `docs/REFERENCE.md` for current workflows and commands.
- Consult `docs/DECISIONS.md` and `docs/MILESTONES.md` when interpreting `DEV_AGENTS_SPEC.md` or historical implementation guidance; do not restart completed milestones.
- For frontend changes, follow `docs/FRONTEND_BRIEF.md`, `docs/UI_IMPLEMENTATION_PLAN.md` and `design/ui/README.md`, alongside the existing components and styles.
- Use Node.js 24.x and npm. Preserve strict TypeScript, framework-independent domain/engine contracts, sandbox enforcement and frozen task/team snapshots.
- Claude Code can contribute to this repository; this does not mean the DevAgents product has a working Claude execution adapter. Describe engine support according to the implemented code.
