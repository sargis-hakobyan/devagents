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

## Encrypted credential storage — 2026-10-29

- Supersedes the earlier plaintext credential-file decision. Docker persists AES-256-GCM encrypted credentials only; the separate 256-bit master key lives in macOS Keychain or Linux Secret Service, retrieved by the launcher over pipes without command-line key arguments.
- Ciphertexts use fresh 96-bit nonces, a 128-bit authentication tag and a versioned authenticated context. Wrong keys/tampering fail closed. Writes are atomic and synced before the legacy plaintext file is removed.
- Codex requires decrypted credentials at runtime. Store them and the master key in a private verified Linux tmpfs mount, explicitly denied to worker tools. Native logins use Codex’s OS keyring backend instead of file storage; keyring failure never falls back to plaintext.
- Container restarts lock the vault until `./devagents start` retrieves the OS keychain key. Missing OS keys do not generate replacements for existing vaults. Keys are scoped to the launcher checkout path, and migration does not erase historical backups.
- This protects persisted data; a compromised owning OS account, host administrator or running application can still access decrypted credentials. Encryption does not resolve API billing limits.


## Guided authentication — 2026-10-29

- Supersedes the API-key-only first-run prompt. Startup offers ChatGPT device sign-in, hidden API-key input, and saved-login reuse, with billing/allowance explained before selection. Authentication contracts are separate from provider/model configuration for future adapters.
- `--auth chatgpt|api-key|saved` supports direct selection; `--replace-key` remains compatible. Noninteractive startup never asks for secrets or consumes model usage unless `--test-connection` is explicitly supplied.
- Status interprets the pinned CLI’s login status without exposing raw output or key fragments. Storage success and verified model access are separate. A failed/mismatched login never falls back to testing the previous method.
- Optional connection test uses the existing restricted Codex adapter, a fixed prompt, empty disposable workspace, no command/write grants, and a 45-second bound. It checks the saved profile and runtime default model only, not explicit environment-key overrides or all agent models. Failures produce fixed actionable messages and retain credentials; cancellation terminates the model process.
- No paid/live account request is part of automated tests. Real Codex status and connection-probe protocol are covered by isolated fake-key and loopback fixtures. ChatGPT browser completion and the authenticated M2 fixture still require user participation and available account allowance.

## Live review contract — 2026-10-29

- The ChatGPT-authenticated fixture exposed ambiguity in `findings`: the model used it for positive review observations while approving. Define findings as actionable repair defects in both the prompt and schema descriptions; positive observations belong in summary.
- Keep the existing fail-closed commit gate: approval with any outstanding findings still requires repair. Do not silently discard findings or trust the approval boolean alone. A regression fixture covers contradictory approval; the subsequent live container fixture passed through local commit.


## M3 DAG execution — 2026-10-29

- Keep the established framework-independent runner and SQLite evidence store. Admit one top-level request at a time; execute ready work items in deterministic waves capped by global and per-role concurrency. Reviewer calls also respect role limits. Immediate slot-refill scheduling and cross-request concurrency are deferred.
- Plans assign agents, dependencies, unique owned branches, scoped writable paths, and an integration agent/combined validation. Ownership is a subset of registry grants and is passed into the runtime sandbox. Custom roles work through the existing config registry.
- Snapshot the integration index with Git write-tree/commit-tree for dependency baselines without advancing the task branch. Workers produce private reviewed item commits; three-way patch application combines their changes serially into the task worktree. No original-checkout merge or external push occurs.
- Explicit integration repairs resolve conflicts within the union of approved owned paths and the integration role's existing permissions. All item checks plus combined checks and independent full-diff review run before the final task commit. Custom repository merge drivers, filters, hooks, global/system attributes and pathspec magic cannot be used to execute arbitrary integration hooks.
- Persist item states, workspace/checkpoint identities, run correlation and integration intents/results as append-only evidence. CLI/API project the latest item states. Restart recovery never replays half-completed Git work; task failure/cancellation preserves private worktrees and marks unfinished items interrupted/blocked/cancelled. Final task commit remains a non-cancellable lifecycle boundary; private checkpoint writes may finish during cancellation.
- Failed workers abort and drain siblings before releasing the request slot. Per-item repair budgets and a shared integration repair budget are bounded. Read-only Node/npm validation and bounded text-only changes remain unchanged.

## Planner schema compatibility — 2026-10-29

- Isolated the M3 live truncation to `ScopedPath`'s regex in the generated structured-output schema. A bounded live probe asking only for `{"ownedPaths":["project:/a.cjs"]}` reproduced `max_output_tokens` with the regex; the identical request with a plain string schema completed in 21 output tokens. This establishes a compatibility issue in the tested runtime/model path, not a general claim that regex schemas are unsupported.
- Omit only that regex from model generation hints and describe the path format instead. Preserve the original Zod schema, traversal/character validation, registry ownership checks and sandbox enforcement before execution. Other schema constraints remain unchanged. Regression tests reject invalid paths and permission widening before any implementation call.
- No model switch, token-limit override, account change or automatic retry loop. The live smoke command now reports phase starts/completions without dumping prompts or credentials.
- Once planning succeeded, the live workers exposed a second runtime limitation. A credential-free Linux protocol probe with an exact-file write grant failed in bubblewrap while constructing protected paths beneath the file (`result.txt/.git`, `result.txt/.aws`). Nested profile syntax reproduced the same failure. Directory-subtree grants pass shell/patch execution and sibling-write denial. Reject Linux exact-file write grants before model execution; never widen an approved scope. The planner receives this platform limitation, and the three-item fixture uses separate owned directories with tests outside them.
- Concurrent live workers then hit the container's 128 PID/thread cap: cgroup `pids.events` recorded six limit hits and no memory OOM events. Raise the finite Compose cap to 512 for the default two workers. Docker fixtures now inherit Compose PID/CPU/memory limits and run two real Codex protocol workers concurrently; the previous standalone protocol fixture did not exercise these resource limits. Higher configured concurrency still requires capacity testing.
- The next live run passed worker execution/tests but its dependent-item reviewer demanded combined test evidence before integration. Separate item integration approval from final task approval in the review contract; planner item criteria cover their own deliverable/checks. The combined gate still runs all item/combined checks and independent full-diff review, and any findings still block commit. Review context now records actual original HEAD/status comparisons and their limits rather than asking workers to access the original checkout.
- Make every planned validation command use the existing supported forms. A subsequent planner invented an inline `node -e` checkout probe; the validator rejected it before implementation. Clarify the planner contract and retain that rejection as a regression test rather than expanding command permissions.

## Pre-M4 review fixes — 2026-10-29

- Two-tier redaction (review finding F1). The heuristic `key=value` masking rewrote code identifiers such as `token: string` inside the diff shown to reviewers and in repair feedback, silently weakening the independent review gate. Model input, stored task requests and plans, and API/CLI output now use value-only redaction: known secret values plus unmistakable credential tokens. Events, evidence and logs keep the heuristic tier. Regression tests cover the real adapter stdin and the implementation, review and repair prompts.
- Plan-time executability checks (review finding F6). `validatePlan` previously accepted plans that execution then rejected, so in plan-approval mode a user could approve a plan that failed immediately. Validation-command allowlisting, implementer and independent-reviewer selection and the Linux subtree write-grant rule now live in `src/domain/{validation,roles,ownership}.ts` and are used by `validatePlan`, both runners, the Codex validator and the sandbox, so approval-time and execution-time rules cannot drift. The platform is injected through `TaskService` for tests; the sandbox always uses the real platform. The deterministic DAG fixture now uses directory grants so it is valid on Linux as well.
- Hidden-file integrity (review finding F2). Validation ran in the worktree while review and commit saw only tracked and non-ignored files, so an ignored file created by a worker could make tests pass without being reviewed or committed. Each implementation call now snapshots untracked-but-ignored files (`ls-files --others` minus `--exclude-standard`) with an unforgeable inode/size/mode/ctime fingerprint and fails the task on any created, modified or removed hidden file. Ignore-rule edits are accounted for by recomputing visibility after the call; dotfiles are additionally outside the `**` write policy. Pre-installed dependencies remain allowed while unchanged.
- Shutdown is not cancellation (review finding F3). Stopping the service aborted in-flight work through the same signal as a user cancellation, so interrupted tasks were recorded as `cancelled` by the orchestrator and recovery never surfaced them. The runner now records a shutdown as `failed` with the reason "Service shutdown interrupted execution", DAG items record `interrupted` (shutdown), `aborted` (sibling failure) or `cancelled` (user) with reasons, and unstarted dependents are `blocked`. The event history therefore distinguishes a user decision from an operational interruption.
