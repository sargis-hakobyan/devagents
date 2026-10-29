# Decision log

## User-confirmed choices — 2026-10-29

- Register existing local Git checkouts by absolute path; mount each explicitly in Docker. Do not clone/import.
- Implement Codex first. Keep coding runtimes separate from inference providers and models.
- Offer API keys and officially supported login flows, with provider-specific restrictions visible.
- Provide named built-in roles and YAML/Markdown custom agents with descriptions, instructions, model/provider selection and permissions.
- Local inference is a follow-up phase, with extensible configuration from the start.
- Existing remote resolves repository owner: `sargis-hakobyan/devagents`. Keep Apache-2.0.

## First implementation increment — 2026-10-29

- Strict TypeScript, Zod, Node 24 SQLite, native HTTP API and CLI client; no custom UI.
- Transactional state/events, idempotent submissions and optimistic approval versions.
- Private data-directory bearer token; browser-origin requests rejected; loopback host publishing.
- Registry precedence project > user > built-in. Definitions are data, never executable packages.
- Mastra compatibility proven separately; domain storage stays framework-independent.
- Worktrees begin from committed HEAD; dirty user changes stay untouched in the original checkout.
- Execution, push, merge and deploy stay disabled in M1. `ready` means a durable plan checkpoint, not a completed coding task.
- Dedicated Codex profile with no host-home/credential copying or Docker socket mount.
- Recovery marks interrupted execution failed for inspection; no automatic replay of side effects.

## M2 execution increment — 2026-10-29

- One serial worker and one implementation item per task. The dynamic Tech Lead selects from the snapshotted registry; independent review uses a different role and fresh runtime process.
- Keep the state machine/SQLite worker framework-independent for this vertical slice. Mastra remains a tested orchestration candidate for later scheduling; it does not own approvals or Git effects.
- Codex exec 0.160.1 only; JSONL, strict structured outputs, bounded output/time and process-group cancellation. Unsupported engines/providers fail before implementation.
- Explicit permission profiles, no tool networking, no nested delegation, no user/project configuration or hooks/plugins. `agents.enabled=false` is required in addition to feature flags. Protocol tools can appear in `additional_tools` input items rather than the legacy `tools` field.
- Validation is restricted to Node/npm test/build checks in a read-only worktree. No dependency download, artifact-producing project build, binary changes or arbitrary permission globs in this increment.
- Append-only evidence includes run identity, normalized progress, actual test results, review decisions and worktree/commit intents. Interrupted side effects fail for inspection, never replay automatically.
- A dedicated SQLite OS lock prevents two services owning the same data directory and releases after crashes. `committing` is a short, non-cancellable finalization boundary; cancellation before it still terminates worker processes.
- Credential-free acceptance uses deterministic orchestration plus real sandboxed tests/Git, and a local Responses fixture exercising the actual Codex shell/patch tools. This does not substitute for authenticated model acceptance.

## Persistent first-run API-key setup — 2026-10-29

- `./devagents start` builds/starts Compose and prompts only when the dedicated Codex profile lacks credentials. `--replace-key` explicitly replaces the saved login.
- Reuse Codex’s file credential store in the persistent data volume instead of a second key database. Protect its directory/file with `0700`/`0600`; the file is not encrypted.
- Hidden terminal input, no command-line/environment key injection, no secret output, and cancellation before saving preserves existing credentials. Noninteractive missing-auth setup fails with an actionable message.
- Saving credentials checks local persistence, not model access or billing. Existing environment-variable and ChatGPT device-login commands remain supported.
