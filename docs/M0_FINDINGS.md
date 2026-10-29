# M0 compatibility findings

Investigated 2026-10-29. Documentation claims and observed behavior are distinguished below.

## Demonstrated

- Native environment: macOS ARM64, Node 24.18.0, npm 11.16.0, Codex CLI 0.160.1, Claude Code 2.1.229.
- Docker environment: Linux ARM64, Engine 24.0.6, Compose 2.22.0. The image pins Node 24.18.0 and Codex 0.160.1.
- `npm run spike:mastra`: Mastra 1.80.0 / LibSQL 1.27.1 suspended a workflow and resumed after storage/runtime recreation. This is not a process-crash test.
- `npm run check`: native types, tests and production compilation.
- `npm run test:docker`: build/start, health, missing authentication, explicit project mount, non-root/read-only service, task/event persistence after restart and idempotent retry.
- `node scripts/sandbox-spike.mjs`: native Codex profile allowed fixture workspace reads/writes; denied outside reads/writes and workspace `.env` reads. The same fixture passes under Docker's non-root/capability restrictions. No real secret or model call was used. This command-only probe does not establish isolation of every engine tool.
- The initial Linux sandbox probe rejected a deny rule for a nonexistent `.git` path. Creating the fixture's metadata directory fixed the probe. M2 must test real worktree pointer files and existing metadata layouts, rather than assume all paths are directories.

## Codex

The official [non-interactive interface](https://learn.chatgpt.com/docs/non-interactive-mode) provides `codex exec`, JSONL events, schema-constrained final output and resumption. The pinned binary's help confirms those flags. Normalize vendor events inside the future adapter.

[Authentication](https://learn.chatgpt.com/docs/auth) supports API keys and ChatGPT login, including device-code login when enabled for the account/workspace. DevAgents provides a dedicated profile/login command, without copying host credentials. An account login and paid fixture run have **not** been performed.

[Permission profiles](https://learn.chatgpt.com/docs/permissions) are beta and constrain command filesystem/network access. M2 must also constrain non-command tools and prevent project/user configuration from widening access. The workspace-write preset alone is not evidence for the full permission contract. Model traffic and tool traffic need separate handling.

## Claude

[Headless execution](https://code.claude.com/docs/en/headless) documents the CLI and Agent SDK. [CLI authentication](https://code.claude.com/docs/en/authentication) supports accounts and API keys. The [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) restricts offering claude.ai login in third-party products without prior approval. Therefore Anthropic API-key configuration is represented; embedded subscription login remains unavailable pending an officially permitted integration.

The local binary version was checked. Claude container login and fixture execution were **not** performed. The M1 image includes Codex only; Claude packaging belongs to M4.

## Mastra and storage

[Workflows](https://mastra.ai/docs/workflows/overview), [suspend/resume](https://mastra.ai/docs/workflows/suspend-and-resume) and [storage](https://mastra.ai/docs/storage) support the orchestration seam, with basic compatibility verified by the executable spike. Mastra is currently a development-only dependency. Domain state uses transactional SQLite through Node 24's built-in module. Framework snapshots must not own Git side-effect or approval correctness.

## Remaining gates

1. Authenticated Codex fixture: scoped tools, implementation, actual tests, independent review and local commit.
2. Every runtime tool boundary, including configuration/hooks/plugins, credential isolation and command networking. Unsupported execution stays disabled.
3. In-container account/device login with the user's own credentials; credential-free startup already passes.
4. Linux AMD64 and multi-architecture builds (M5).
5. Real local-model execution/tool behavior in the follow-up phase. Configuration acceptance is not execution support.
