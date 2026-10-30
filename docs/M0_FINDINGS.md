# M0 compatibility findings

Investigated 2026-10-29. Documentation claims and observed behavior are distinguished below.

## Demonstrated

- Native environment: macOS ARM64, Node 24.18.0, npm 11.16.0, Codex CLI 0.160.1, Claude Code 2.1.229.
- Docker environment: Linux ARM64, Engine 24.0.6, Compose 2.22.0. The image pins Node 24.18.0 and Codex 0.160.1.
- `npm run spike:mastra`: Mastra 1.80.0 / LibSQL 1.27.1 suspended a workflow and resumed after storage/runtime recreation. This is not a process-crash test.
- `npm run check`: native types, tests and production compilation.
- `npm run test:docker`: build/start, health, missing authentication, explicit project mount, non-root/read-only service, task/event persistence after restart and idempotent retry.
- `node scripts/sandbox-spike.mjs`: native Codex profile allowed fixture workspace reads/writes; denied outside reads/writes and workspace `.env` reads. The same fixture passes under Docker's non-root/capability restrictions. No real secret or model call was used. This command-only probe does not establish isolation of every engine tool.
- The initial Linux sandbox probe rejected a deny rule for a nonexistent `.git` path. Creating the fixture's metadata directory fixed the probe. The M2 validation fixture now exercises real worktree pointer files as well as existing metadata directories.

## Codex

The official [non-interactive interface](https://learn.chatgpt.com/docs/non-interactive-mode) provides `codex exec`, JSONL events, schema-constrained final output and resumption. The pinned binary's help confirms those flags. The adapter normalizes vendor events and validates structured final output.

[Authentication](https://learn.chatgpt.com/docs/auth) supports API keys and ChatGPT login, including device-code login when enabled for the account/workspace. DevAgents provides a dedicated profile/login command, without copying host credentials. Dedicated container API-key authentication is confirmed. Earlier API-key fixture attempts on 2026-10-29 returned quota/billing errors before implementation. ChatGPT device login subsequently succeeded, and the full live M2 fixture passed in Docker using that saved login.

[Permission profiles](https://learn.chatgpt.com/docs/permissions) are beta and constrain command filesystem/network access. M2 constrains the enabled shell and patch tools and ignores project/user configuration; the protocol fixture checks these boundaries. The workspace-write preset alone is not evidence for the full permission contract. Model traffic and tool traffic need separate handling.

## Claude

[Headless execution](https://code.claude.com/docs/en/headless) documents the CLI and Agent SDK. [CLI authentication](https://code.claude.com/docs/en/authentication) supports accounts and API keys. The [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) restricts offering claude.ai login in third-party products without prior approval. Therefore Anthropic API-key configuration is represented; embedded subscription login remains unavailable pending an officially permitted integration.

The local binary version was checked. Claude container login and fixture execution were **not** performed. The M1 image includes Codex only; Claude packaging belongs to M4.

## Mastra and storage

[Workflows](https://mastra.ai/docs/workflows/overview), [suspend/resume](https://mastra.ai/docs/workflows/suspend-and-resume) and [storage](https://mastra.ai/docs/storage) support the orchestration seam, with basic compatibility verified by the executable spike. Mastra is currently a development-only dependency. Domain state uses transactional SQLite through Node 24's built-in module. Framework snapshots must not own Git side-effect or approval correctness.

## Remaining gates

1. Authenticated native Codex fixture remains unverified; the Linux ARM64 container fixture passed with ChatGPT sign-in. Claude fixture execution remains M4 work.
2. Re-run the pinned runtime protocol/containment fixtures before any Codex upgrade or additional tool is enabled. Current native and Docker shell/patch/network probes pass.
3. Broader account/workspace compatibility beyond the verified personal ChatGPT device-login flow.
4. Linux AMD64 and multi-architecture builds (M5).
5. Real local-model execution/tool behavior in the follow-up phase. Configuration acceptance is not execution support.

## M2 runtime verification — 2026-10-29

- Native deterministic workflow passes actual sandboxed tests, independent review and local Git commit while preserving a dirty original checkout. Cancellation, bounded repairs, invalid review changes and service crash-lock behavior have regression tests.
- The local Responses fixture exercises **the actual Codex CLI** with generated permission profiles, JSONL and structured final output. Shell and patch writes within scope pass; attempts against outside files, `.env`, `.git` and read-only review fail. Command networking is probed separately from the runtime’s model connection. No real credential is used.
- Disabling multi-agent feature flags alone did not remove delegation; `agents.enabled=false` did. Tool descriptions are carried in `additional_tools` input entries in this runtime, so inspecting only the legacy top-level `tools` array gives a false empty result.
- Configuration path keys are supplied as complete TOML inline tables; dotted CLI keys misinterpret paths containing dots. Existing deny targets are enumerated because Linux bubblewrap rejects missing targets. Symlinks and hardlinks discovered before a run are denied; protected changes are also rejected before commit.
- `OPENSSL_CONF=/dev/null` is needed for the native Node fixture because the scoped sandbox cannot read macOS’s system OpenSSL config.
- The protocol fixture’s test-only executable wrapper needs an executable temporary mount in Docker. Production Codex is installed in `/usr/local`; its dedicated runtime home lives on `/run/devagents-auth` tmpfs, with encrypted credentials persisted in `/data`.
- API-key login is confirmed, though its live fixture was blocked by quota. The subsequent ChatGPT-authenticated planning/coding/review fixture passed. This demonstrates the bounded fixture, not arbitrary project or account compatibility.

On Linux, denied parent paths can be hidden behind sandbox-only placeholders: an outside write may succeed inside that namespace without changing the original file. The protocol fixture verifies the original sentinel content after execution instead of relying solely on an error return.

The complete Docker smoke suite passed on Linux ARM64, including the deterministic M2 workflow, actual Codex protocol/tool fixture, container startup, task persistence and retry idempotency.

## Live fixture attempt — 2026-10-29

The dedicated container profile reports authenticated after API-key setup. The live fixture failed on its first planning request with “Quota exceeded. Check your plan and billing details.” No implementation, validation, review or task commit occurred. The temporary fixture was cleaned up; the service profile was retained. Retry after the API organization’s billing/quota issue is resolved. No repeated model calls were made after this error.


## ChatGPT live acceptance — 2026-10-29

The user completed ChatGPT device-code sign-in through the guided launcher and the optional connection test succeeded. Restarting through the launcher restored the encrypted ChatGPT credentials without another sign-in.

The first full live run planned and implemented the greeting fix and passed the actual sandboxed test, but exhausted its repair budget because the reviewer returned `approved: true` with positive observations in `findings`. The commit gate correctly refused nonempty findings. The review prompt and schema descriptions now reserve findings for actionable defects and put positive observations/test evidence in summary; approval requires an empty findings array. A regression test confirms that contradictory approval with outstanding findings still cannot commit.

After the clarification, `docker compose exec -T devagents node scripts/m2-smoke.mjs --live` passed: live planning and implementation, real sandboxed validation, separate review, and a local Git commit. The original fixture checkout was unchanged. The fixture removed only its temporary repository/data; the service credentials remain encrypted and reusable. No push or merge occurred. This closes the container M2 acceptance gate; it does not establish native authenticated, Claude, AMD64, or multi-agent acceptance.

## M3 verification — 2026-10-29

- `npm run check` passed: 61 tests, typecheck and production build. Coverage includes configured specialist concurrency, approval waits, dependency integration, conflict repair, combined review repair, sibling cancellation, ownership denial, original-HEAD divergence, merge-driver refusal and restart evidence recovery.
- Native and Docker Linux ARM64 deterministic three-item fixtures passed with actual sandboxed Node tests, isolated item worktrees, a dependent item consuming both earlier results, independent item/combined reviews and one final local commit. The original checkout remained unchanged. The complete isolated Docker smoke suite passed, including credential persistence and the Codex protocol/tool fixture.
- The running user container was rebuilt and unlocked through saved ChatGPT authentication. Two live M3 attempts stopped during planning with `stream disconnected before completion: Incomplete response returned, reason: max_output_tokens`. Neither reached implementation. Each temporary fixture was removed and service credentials retained.
- The adapter does not configure an output-token cap. A credential-free loopback inspection of the native pinned CLI showed no `max_output_tokens` in its request and default model `gpt-6.1-sol` with low reasoning effort. Its protocol fixture passed. This does not identify the server-side cause of the live failures or prove the live container request has identical defaults. No model/effort changes or automatic retry loop were introduced.

At this checkpoint, authenticated multi-agent acceptance remained open. The following investigation isolates the failures rather than repeatedly retrying the unchanged fixture.

## M3 live compatibility fixes — 2026-10-29

1. A bounded, no-tool live probe reproduced `max_output_tokens` when asking only for `{"ownedPaths":["project:/a.cjs"]}` with the `ScopedPath` regex. The identical request using a plain string schema completed in 21 output tokens. Removing only this generation constraint allowed the full live planner to complete. Local Zod and ownership validation remain authoritative; regression tests reject traversal, backslashes, NUL, unscoped paths and permission widening before implementation. The official [Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs) documents schema constraints and incomplete responses; the specific regex incompatibility here is an observed runtime/model result.
2. The live workers then returned without changes. A credential-free real-runtime probe showed that an exact-file write grant caused Linux bubblewrap to create protected paths beneath a regular file (`result.txt/.git` and `result.txt/.aws`), failing before shell/patch execution. Both direct and nested [permission profile](https://learn.chatgpt.com/docs/permissions) syntax reproduced it. DevAgents now rejects Linux exact-file writes before a model call and directs plans to explicitly permitted directory subtrees. The fixture gives each worker a separate directory and leaves tests outside those scopes. Native and Docker protocol probes verify scoped shell/patch writes and sibling-write denial.
3. With directory scopes, concurrent live workers hit the original Compose limit of 128 processes/threads and reported `SIGTRAP`. The running cgroup recorded six PID-limit hits, a peak of 132, and zero memory OOM events. Compose now allows at most 512 processes/threads. Docker fixtures use the configured CPU, memory and PID limits and exercise two real Codex protocol workers concurrently. Higher concurrency needs separate capacity verification.
4. With runtime limits fixed, all workers passed their tests, but the dependent-item reviewer requested combined validation before integration. Repairing code could not supply the missing orchestrator evidence. Item review now explicitly authorizes only integration; final review still assesses every user criterion against the full diff and actual combined test results. Review evidence also includes original HEAD and Git-status comparisons. These comparisons do not attest ignored files or changes within files that were already dirty/untracked. Regression assertions cover separate gate context and actual combined validation; the existing rejection/repair tests continue to enforce the commit gate.
5. A subsequent plan added an unsupported inline `node -e` checkout probe and was rejected before any worker ran. The planner now receives an exhaustive command contract and is told that original-checkout verification belongs to the orchestrator. The validator remains unchanged; a regression test verifies rejection before implementation.

## M3 authenticated acceptance — 2026-10-29

After these fixes, `docker compose exec -T devagents node scripts/m3-smoke.mjs --live` passed with the saved ChatGPT login and unchanged default model selection. The live planner assigned three items; a and b executed concurrently in isolated worktrees, passed actual tests and independent review, and were integrated before c ran. Item c and the combined result passed validation and independent reviews. The fixture asserted three private item commits, one final combined commit, three distinct worker worktrees, the expected changed-file set, a clean final worktree and preservation of the original checkout. Only its temporary repository/data were removed; encrypted service credentials remain reusable.

The successful service container recorded zero PID-limit hits, a peak of 144 processes/threads against the 512 cap, and zero memory OOM events. `npm run check` passed all 64 tests, typecheck and production build. Native deterministic M3 and native/Docker protocol containment probes passed; the Docker suite includes two concurrent real runtime protocol workers under the configured resource limits. This closes the Linux ARM64 container M3 gate. It does not verify authenticated native execution, AMD64, higher concurrency, Claude, or exact-file writes on Linux.
