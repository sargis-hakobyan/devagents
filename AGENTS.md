# Agent Context for DevAgents

Read this file before working in this repository and read applicable nested
instruction files before changing their directories. This file contains the shared
repository rules; `CLAUDE.md` is the companion entry point for Claude Code.

## Behavioral Defaults

### 1. Think Before Coding

- State material assumptions. Inspect the existing code and relevant docs before choosing an implementation.
- Ask when an unresolved requirement changes the product behavior or scope; use judgment for routine implementation choices.
- Prefer the simplest approach that satisfies the request. Explain meaningful tradeoffs.

### 2. Never Commit Secrets

- Keep credentials, API keys, tokens, login state, task databases and local project data out of code, documentation, fixtures and commits. Use placeholders in examples.
- Preserve the encrypted credential vault, OS keychain integration, private runtime credentials and log redaction. Never print real credentials while debugging.
- Do not copy `.env`, `.devagents/` or authenticated engine profiles into fixtures or worktrees. Use disposable test data and fake credentials.
- Review new content and the staged diff for accidental secrets before committing.

### 3. Simplicity First

- Implement the minimum code needed for the requested behavior.
- Reuse existing modules and patterns. Avoid speculative features, abstractions, dependencies and configuration.
- Remove only unused code introduced by your own changes.

### 4. Surgical Changes

- Check Git status before editing; preserve existing staged, unstaged and untracked work.
- Keep changes within the requested scope, including the implementation, tests and documentation needed to complete it. Leave unrelated cleanup for a separate task.
- Explanation and proposal requests do not authorize implementation.
- Do not reset, overwrite or discard someone else's changes to make checks pass.

### 5. Goal-Driven Execution

- Define observable success criteria. For substantial work, give a short plan and identify how the outcome will be verified.
- For bugs, reproduce the failure and add a meaningful regression test when practical.
- Continue through implementation and relevant verification. Fix failures caused by the change; distinguish pre-existing failures and missing prerequisites.
- Report what changed, which checks ran and any remaining gaps. A typecheck alone does not verify interactive or visual behavior.

### 6. Browser Automation Restraint

- Start with code inspection and focused unit, integration or API checks when they can establish correctness.
- Use browser tests or screenshots when interaction, layout or browser behavior needs verification, or the user requests it.
- Use the deterministic UI fixture for browser tests. Keep temporary artifacts under ignored `test-results/`, `playwright-report/` or a temporary directory, not the repository root.

### 7. Documentation Maintenance

- Update `README.md` and the relevant setup/reference docs when changing user-facing behavior, commands, configuration or prerequisites.
- Record architectural decisions in `docs/DECISIONS.md`; update `docs/MILESTONES.md` when milestone status changes.
- Keep example configuration and built-in agent YAML/Markdown consistent with schema or role changes.
- Describe implemented behavior separately from planned work and historical verification.

## Repository Context

DevAgents is a local-first AI development-team orchestrator. It uses TypeScript,
Mastra workflows, Zod validation and SQLite persistence. The browser UI uses
Preact, Vite and local CSS. Codex execution is implemented; other engines must
not be presented as working until implemented and verified.

| Location | Responsibility |
| --- | --- |
| `src/domain/` | Schemas, lifecycle, plans, roles and policy contracts |
| `src/orchestration/` | Mastra workflows, execution, DAG scheduling, validation and review |
| `src/engines/` | Coding-engine adapters, processes, sandbox and preparation |
| `src/workspace/` | Git worktrees, integration, diffs, cleanup and compaction |
| `src/persistence/` | Durable task state, evidence and service locks |
| `src/api/`, `src/cli/` | HTTP/browser sessions and command-line workflows |
| `src/security/`, `src/setup/` | Credential vault and authentication setup |
| `agents/builtin/` | Built-in YAML definitions and Markdown instructions |
| `ui/src/` | Pages, components, API client and styles |
| `tests/`, `scripts/` | Unit/integration/browser tests, fixtures and smoke checks |

Read documentation according to the task:

- `README.md` and `docs/SETUP.md`: user workflows and environment setup.
- `docs/REFERENCE.md`: current commands, architecture, configuration and security contracts.
- `DEV_AGENTS_SPEC.md`, `docs/DECISIONS.md` and `docs/MILESTONES.md`: product scope, decisions and implementation status. Check later decisions and current code before relying on an older spec passage.
- `docs/FRONTEND_BRIEF.md`, `docs/UI_IMPLEMENTATION_PLAN.md` and `design/ui/README.md`: UI behavior and visual references when changing the frontend.
- `IMPLEMENTATION_PROMPT.md`: historical implementation guidance and owner decisions; do not restart completed milestones or treat past live-test authorization as current authorization.

## Development and Dependency Rules

- Use Node.js 24.x and npm for this repository. `package.json` and `package-lock.json` define dependencies; use `npm ci` for a reproducible install.
- Keep dependency changes deliberate and necessary for the task; update the manifest and lockfile together. Do not introduce another package-manager lockfile.
- Preserve strict TypeScript checks. Follow existing ESM imports, including `.js` extensions in backend TypeScript imports.
- Keep task/domain, policy, workspace and engine contracts independent of Mastra-specific orchestration details.
- Edit source files, not generated `dist/` output or installed dependencies.

## Verification Commands

| Purpose | Command |
| --- | --- |
| Backend/test typecheck | `npm run typecheck` |
| UI typecheck | `npm run typecheck:ui` |
| Focused test file | `./node_modules/.bin/tsx --test tests/unit/plan.test.ts` (substitute the relevant file) |
| Unit and integration suite | `npm test` |
| Backend and UI build | `npm run build` |
| Combined standard checks | `npm run check` |
| Browser workflow tests | `npm run build && npm run test:ui` |
| Single-item / DAG smoke fixtures | `npm run test:m2` / `npm run test:m3` |
| Codex protocol fixture | `npm run test:codex-protocol` |
| Container smoke checks | `npm run test:docker` |

Choose checks proportional to the change. `npm run check` excludes browser tests;
there is no lint script. Documentation-only changes need content, path and command
verification, not a full application test run. Browser tests require Chromium and
use `scripts/ui-fixture.mjs`; runtime/container smoke tests have additional local
prerequisites documented in `docs/REFERENCE.md`.

Default tests use deterministic fixtures without paid credentials. Live model
tests (`test:codex-live`, `test:m3-live`) and authenticated connection checks consume
account allowance or API credits: run them only when authorized for the current
task. Reuse that authorization within its scope rather than asking at every step.

## Product and Security Invariants

- Keep engine sandbox enforcement and permission checks in code. Optional DevAgents restrictions being disabled does not disable the engine sandbox.
- Preserve isolated worktrees, frozen task/team snapshots, version-bound approvals, bounded repair loops and persisted execution evidence.
- Developer validation and independent review remain meaningful gates. Report optional unavailable checks honestly; do not convert an unverified required acceptance criterion into success.
- Preserve CLI bearer authentication and browser session/CSRF protections. Render model output, task text and logs as untrusted content.
- Never expose host home directories, the Docker socket or real credentials to worker fixtures. Cleanup and compaction must prove ownership and preserve the work their contracts promise to retain.
- DevAgents produces local results; do not add automatic pushing or merging into users' original checkouts.

## Technical UI Design Standard

- Extend the existing Preact components and styles in `ui/src/components/` and `ui/src/styles.css`.
- Follow the selected indigo/amber direction and compact layouts in `design/ui/README.md`. Keep design boards and implementation aligned, or record intentional differences.
- Show real backend states and evidence. Do not invent progress percentages, cost estimates or verified model access.
- Provide clear loading, empty, error and pending states. Use text/icons alongside status colors and accessible labels for controls.
- Preserve the existing stack; a routine UI change is not a framework or design-system migration.

## Git and Commit Rules

- Stay on the current branch; the existing development workflow uses local `main`. Create or switch branches only when explicitly requested.
- Local commits are allowed by the existing project instructions; stage only the intended files and inspect the staged diff first.
- Use short, specific, imperative commit subjects without `Codex` or `Claude` prefixes. Include concise rationale in the body when useful.
- Push only when explicitly requested for the current work. Earlier push permission does not authorize a later push.
- These contributor rules are separate from the managed task branches and commits created by DevAgents itself.
