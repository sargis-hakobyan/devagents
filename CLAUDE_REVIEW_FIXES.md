# Review fixes: F1 and F6

Companion to `CLAUDE_REVIEW.md`, which reviewed commit `d9dd377` and is unchanged. This file records the two blocker fixes, how they were tested, and what was deliberately left alone. Nothing was pushed; no authenticated model run was performed; no credential store was inspected.

## Commits

| Commit | Content |
| --- | --- |
| `6f4df85` | `CLAUDE_REVIEW.md`, the original review (report only) |
| `690275e` | F1: value-only redaction for model prompts, task rows, API and CLI output |
| `4fcda54` | F6: plan-time executability checks shared with execution |
| this commit | `CLAUDE_REVIEW_FIXES.md` |

## F1. Preserve code syntax in model prompts

Problem (see `CLAUDE_REVIEW.md` F1): the heuristic `key=value` redaction ran over the entire model prompt, so a diff containing `token: string` reached the reviewer as `token: [REDACTED]`; the same happened to repair feedback and, through the persisted task row, to the request and plan text used in every prompt.

Change:

- `src/telemetry/redact.ts` now exports two functions. `redactValues` removes known secret values (configured provider keys, environment variables whose names look like credentials) and unmistakable credential tokens (`sk-…`, `ghp_…`, `github_pat_…`) and nothing else. `redact` keeps the previous heuristic tier (bearer headers, `key=value` assignments, credential-looking object keys) on top of it.
- `src/engines/codex/adapter.ts` sends the engine `redactValues(prompt)` on stdin. Progress events and failure text still use `redact` because they become evidence.
- `src/persistence/store.ts` writes task rows (request, plan, workspace, outcome) with `redactValues`; events and evidence keep `redact`. The idempotency fingerprint is unchanged.
- `src/api/server.ts` and the CLI `print` use `redactValues` so plans stay readable; rows are already redacted at rest.

Tests added:

- `tests/unit/redact.test.ts`: code identifiers survive `redactValues`; literal secrets and credential tokens are removed; short values are never used as patterns; `redact` still masks heuristically.
- `tests/unit/adapter.test.ts`: a shim engine captures the real stdin. Asserts the code reaches the model unchanged while an environment secret, the provider API key and an `sk-…` token are replaced.
- `tests/integration/runner.test.ts` ("model prompts keep code syntax…"): request, plan description and review findings containing `token: string` appear verbatim in the implementation, review and repair prompts; the literal fixture secret is absent from prompts, events and evidence.
- `tests/integration/api.test.ts`: the task returned by the API keeps `token: string` and drops the fixture secret.

Deliberate trade-off: evidence and event text keep the heuristic tier, so quoted code in evidence may still show `[REDACTED]`. A model that echoes a secret in its output has that output redacted when it is persisted and again (value tier) when it is fed into the next prompt by the adapter.

## F6. Reject unexecutable plans before approval

Problem (see `CLAUDE_REVIEW.md` F6): `validatePlan` did not check validation-command shape, reviewer independence or the Linux subtree write-grant rule; execution did. In plan-approval mode a user could approve a plan that failed on its first step.

Change:

- New `src/domain/validation.ts` (`assertValidationCommand`, `assertValidationCommands`), `src/domain/roles.ts` (`selectImplementer`, `independentReviewer`) and `assertSupportedWriteGrant` in `src/domain/ownership.ts`. The validation allowlist moved out of `src/engines/codex/validator.ts`, which now imports it.
- `src/domain/plan.ts` applies all three rules per item, to the integration step, and requires a reviewer independent of every implementer and the integrator. `validatePlan` takes `{ platform }` (default `process.platform`).
- `src/orchestration/service.ts` accepts an optional `platform` and passes it to `validatePlan`. `src/orchestration/runner.ts` uses it for the planner's Linux hint and uses the shared helpers for the single-item path; `src/orchestration/dag-runner.ts` uses them for the DAG path. Execution-time enforcement is retained in both.
- `src/engines/codex/sandbox.ts` calls `assertSupportedWriteGrant(pattern, process.platform)`; the error still contains "Exact-file writes cannot be safely executed", which the Linux protocol smoke asserts.

Tests added or changed:

- `tests/unit/plan.test.ts`: `node -e` and empty validation rejected; exact-file ownership rejected on `linux`, accepted on `darwin`; subtree ownership accepted on `linux`; a self-reviewing role with the builtin reviewer disabled is rejected; a two-item plan with integration passes on `linux`; an unsupported integration command is rejected.
- `tests/integration/runner.test.ts` ("plan approval is never requested for a plan that could not execute"): three plan-approval scenarios (inline command, Linux exact-file grant via injected platform, no independent reviewer) end `failed` during `planning`, store no plan, never emit `awaiting_plan_approval`, and make exactly one engine call. The Linux scenario also asserts the planner prompt carries the subtree hint.
- `tests/integration/dag-runner.test.ts`: the fixture now uses per-item directories and `project:/<dir>/**` grants, so the suite is valid under the Linux rule; it also asserts every worker's write scope equals its item's owned paths (closing test gap 6 from the review). The unsupported-validation test asserts no plan is stored.
- `tests/helpers.ts`: `validPlan()` includes a validation command, since plans without one are now rejected at proposal time.

## Verification

Run natively on macOS ARM64 with Codex CLI 0.160.1 installed, no credentials, after both fixes:

| Check | Result |
| --- | --- |
| `npm run check` | Pass: typecheck, 70 tests (64 before), 0 failures, production build |
| `npm run test:m2` | Pass, including the containment probe |
| `npm run test:m3` | Pass: three items, isolated worktrees, dependency integration, item and combined reviews, one final commit, original checkout unchanged |
| `npm run test:codex-protocol`, `npm run test:docker`, live fixtures | Not run (same reasons as in the review) |

## Documentation updated

- `README.md`: redaction tiers in "API and security"; plan-time checks in "Multi-agent plans and progress"; exact-file writes rejected at plan validation.
- `docs/DECISIONS.md`: new section "Pre-M4 review fixes — 2026-10-29".
- `docs/MILESTONES.md`: M3 checklist entry for the fixes; acceptance test count 70.

## Not changed in this pass

The remaining findings in `CLAUDE_REVIEW.md` (F2 through F17) were untouched by the F1/F6 pass; F2 through F5 are addressed in the second pass below. M4 was not started.

---

# Review fixes: F2 to F5

Second pass, same ground rules: `CLAUDE_REVIEW.md` is unchanged; nothing was pushed; no authenticated model run; no credential store inspected. Each fix is its own commit with regression tests.

## Commits

| Commit | Content |
| --- | --- |
| `26b8fdd` | F2: hidden-file integrity around every implementation call |
| `0605e91` | F3: service shutdown recorded as failed with an explicit reason |
| `20b64b1` | F4: configurable scan limit and collapsing of fully-denied directories |
| `5ecd6ca` | F5: content-based conflict resolution that allows Markdown underlines |
| this commit | this record, milestone checklist and test count |

## F2. Hidden files cannot influence validation unseen

Problem: validation ran in the worktree while review and commit saw only tracked and non-ignored files, so a worker could create an ignored helper that made tests pass without being reviewed or committed.

Change: new `src/workspace/hidden.ts`. Before every implementation call (item implementation, conflict repair, combined repair in the DAG runner; the single-item runner's implementation) the worktree's hidden files are snapshotted: `git ls-files --others` minus `git ls-files --others --exclude-standard`, each fingerprinted by inode, size, mode and kernel ctime (which an unprivileged sandboxed process cannot set). After the call the snapshot is recomputed with the then-current ignore rules and any created, modified or removed hidden file fails the task with `hidden_changes` before validation. `git()` gained an optional output buffer size so large dependency trees can be listed.

How ignore-rule changes and existing dependencies are accounted for:

- Visibility is recomputed after the call, so a file hidden by a new or edited ignore rule is a created hidden file and is rejected; a file made visible by a rule change is simply reviewed. In practice the `**` write policy does not match dotfiles, so workers cannot edit `.gitignore` at all today; the snapshot logic does not rely on that.
- Dependencies installed into the worktree before implementation (for example while paused at plan approval) are in the baseline and stay allowed while unchanged. Modifying or deleting one is rejected.

Tests: five single-item scenarios in `tests/integration/runner.test.ts` (new ignored file used by tests, new ignore rule hiding a new file, untouched dependency completes, modified dependency, removed dependency) and a DAG worker writing an ignored file inside its owned directory in `tests/integration/dag-runner.test.ts`.

Limitation: the fingerprint detects changes, not intent; a legitimately regenerated ignored artifact is rejected too. The check runs once per implementation call, which lists every ignored file; on very large dependency trees this adds a directory walk per call.

## F3. Shutdown is not cancellation

Problem: `TaskRunner.stop()` aborted in-flight work through the same signal as a user cancellation, so a `docker compose restart` left the task `cancelled` by the orchestrator and recovery never surfaced it, contrary to README and the decision log.

Change: the runner records a shutdown-interrupted task as `failed` with the reason "Service shutdown interrupted execution; inspect preserved worktrees and evidence before submitting a new task" (the underlying error is appended). DAG work items record why each worker stopped: `interrupted` (shutdown), `aborted` (a sibling failed and drained the wave), `cancelled` (user) or `failed`, each with a reason; unstarted dependents are `blocked` with a shutdown reason. `Store.workItems` keeps the new states final. This also closes the sibling-labelling point noted as F14 in the review.

Tests: single-item shutdown asserts the failed state and reason, no `cancelled` event, and an empty `recover()` on the reopened store; DAG shutdown during a wave asserts interrupted workers and blocked dependents; the sibling-failure test asserts the drained worker is `aborted`.

Docs: README troubleshooting now distinguishes shutdown, crash and `tasks cancel`.

## F4. Sandbox scan bounded configurably without weakening containment

Problem: the per-launch deny scan stopped at 50,000 entries and emitted one deny flag per symlink or hardlink, so worktrees with installed dependencies failed closed or produced very long Codex command lines.

Change, deliberately narrow:

- `workspaceScanLimit` configuration (default 200,000, range 1,000 to 2,000,000) replaces the constant; the limit still fails closed and the error names the setting. It is passed from the service configuration to `CodexAdapter` and `CodexValidator`.
- A directory whose every entry is denied (protected name, symlink, hardlink, or a fully-denied subdirectory) is denied as a whole instead of entry by entry. This is strictly stricter: the same files are unreadable and the directory listing is hidden too. Directories with any regular entry are unchanged: their links are denied individually and their regular files stay readable. The workspace root never collapses.

What was not done, on purpose: ignored directories are still scanned; `node_modules` is not trusted; scans are never cached or reused between launches; symlink and hardlink denial is unchanged.

Tests: `tests/unit/sandbox.test.ts` parses the generated profile and asserts collapsed, mixed, nested and empty directory handling and the configurable limit. `tests/integration/sandbox-containment.test.ts` runs the real pinned Codex sandbox when `codex-cli 0.160.1` is installed (skipped otherwise) and asserts collapsed directories, links through them and outside paths are unreadable while sibling regular files remain readable and the worktree stays read-only.

Remaining limitations, documented in README and the decision log rather than claimed resolved: one directory walk per engine or validation launch; hardlinked package stores (pnpm) and `node_modules/.bin` symlinks remain denied, so validation scripts that invoke binaries through `.bin` do not run; raising the limit for very large worktrees lengthens each launch. A per-engine capability model and an incremental scan are M4/M5 design work.

## F5. Conflict resolution judged on content, Markdown underlines allowed

Problem: the repair check treated every bare `=======` line as a conflict marker, so a conflicting Markdown file with a setext heading could never be resolved.

Change: new `src/workspace/conflicts.ts`. Any `<<<<<<<`, `|||||||` or `>>>>>>>` line of seven or more characters (repository attributes may lengthen markers) is unresolved. A bare `=======` is unresolved only when the file contains more of them than "ours" or "theirs" had; those counts are read from index stages 2 and 3 before the repair, because staging discards them. After the integrator's repair the files are checked by content; only then are they staged, and Git must additionally report no unmerged entries. Staging alone is never accepted as proof. Each unresolved file and reason is recorded as `integration-unresolved` evidence.

Tests: `tests/unit/conflicts.test.ts` covers headings, leftover dividers, lengthened and diff3 markers and look-alike lines. DAG tests cover a conflicting Markdown file that resolves with its heading intact and completes, and repairs that leave markers or an extra separator and are not accepted.

Limitation: a repair that legitimately adds a brand-new setext heading to a conflicted Markdown file would be flagged as an extra separator and would need another repair cycle; the evidence names the file and the count so this is diagnosable.

## Verification

Run natively on macOS ARM64 with Codex CLI 0.160.1 installed, no credentials, at commit `5ecd6ca` (all four fixes applied):

| Check | Result |
| --- | --- |
| `npm run check` | Pass: typecheck, 80 tests (70 after F1/F6), 0 failures, 0 skipped, production build |
| `npm run test:m2` | Pass, including the containment probe against the real Codex sandbox |
| `npm run test:m3` | Pass: three items, isolated worktrees, dependency integration, item and combined reviews, one final commit, original checkout unchanged |
| `tests/integration/dag-runner.test.ts` run 3× | 16/16 pass each run |
| `tests/integration/sandbox-containment.test.ts` | Ran (not skipped) against the pinned Codex; passes |
| `npm run test:codex-protocol`, `npm run test:docker`, live fixtures | Not run (same reasons as in the review) |

`npm run check` was also run and passed before each of the four commits.

## Documentation updated

- `README.md`: hidden-file integrity in "API and security"; worker stop reasons and shutdown behaviour in "Multi-agent plans and progress" and "Troubleshooting and limits"; sandbox scan bound, collapsing and known limits in "API and security"; conflict-resolution rules in "Multi-agent plans and progress".
- `docs/DECISIONS.md`: four bullets appended under "Pre-M4 review fixes — 2026-10-29".
- `docs/MILESTONES.md`: checklist entry extended; acceptance test count 80.
- `examples/devagents.yaml`: `workspaceScanLimit`.

## Still open after the second pass

Findings F7 through F13 and F15 through F17 were addressed in the third pass below. M4 was not started.

---

# Review fixes: F7 to F17

Third pass, same ground rules: `CLAUDE_REVIEW.md` is unchanged; nothing was pushed; no authenticated model run; no credential store inspected. Each finding has its own commit with regression tests; `npm run check` passed before every commit.

## Commits

| Commit | Finding | Content |
| --- | --- | --- |
| `56adf3b` | F7 | `tasks cleanup <id>` / `POST /tasks/:id/cleanup` for managed worktrees and item branches |
| `bc878da` | F8 | Planner shell kept as a documented decision; adapter test of phase write grants |
| `c5deea7` | F9 | A rejection without findings is malformed review output |
| `67bbb6c` | F10 | Truncated validation output as evidence; `git_output_limit`; bounded planning listing |
| `3169244` | F11 | One protected-path definition in `src/domain/protected-paths.ts` |
| `2e56ff5` | F12 | Serialized, change-aware, torn-read-tolerant credential sealing |
| `5d03b53` | F13 | Worktree creation serialized per repository |
| `01858e6` | F15 | `GET /tasks` returns summaries |
| `968fc60` | F17 | Data directory tightened to `0700` on every start |
| this commit | | this record, milestone checklist and test count |

F14 (sibling aborts labelled `cancelled`) was closed by the F3 commit `0605e91`, which records `aborted` with a reason. F16 (single-item reviewer selection looser than the DAG path) was closed by the F6 commit `4fcda54`, which routes both paths through `independentReviewer`.

## F7. Explicit cleanup of managed worktrees and branches

`WorkspaceManager.cleanup` removes a terminal task's registered worktrees under `<data>/worktrees/` and deletes its `codex/devagents-<task>…` branches, keeping a completed task's branch because it holds the reviewed commit, then prunes stale registrations. Every entry is validated before anything is removed; a path that is not under the managed directory, does not carry the task ID, or is the user's checkout is refused and nothing is touched. Active tasks are refused with 409. The result is recorded as `cleanup` evidence. Nothing is automatic.

Tests: completed single-item task (worktree gone, branch kept at the reviewed commit, user's dirty file and `user-feature` branch untouched, idempotent re-run); failed task (branch deleted); forged `work-item` evidence pointing at the user's checkout refused with nothing removed; completed DAG task (four worktrees and three item branches removed, task branch kept).

Limitation: dependency checkpoint commits become unreachable objects after item branches are deleted and are left to normal Git garbage collection. No retention sweep exists; users run cleanup per task.

## F8. Planner shell access: decided, documented, tested

Decision: the Tech Lead keeps `allowCommands: true`. The pinned runtime reads files through its shell tool, and planning quality depends on inspecting the project. The planning process has no project write grants, a writable temp directory only, and no network, so the exposure is sandboxed code execution triggered by repository content before approval. README explains this and how to override `tech-lead` with `allowCommands: false`. An adapter test captures the real argv and asserts that planning and review processes carry no write grants beyond temp even for a writable role, that implementation does write the project, and that the shell tool follows `allowCommands`.

## F9. Rejection without findings is malformed output

`ReviewOutput` requires at least one finding when `approved` is false. The generated model schema is unchanged; the rule is local. A violation fails the run as malformed engine output with a clear message instead of sending an empty repair instruction and spending a repair cycle. Tests: schema cases and a runner test asserting zero repair cycles and a `run-failed` evidence entry naming the rule.

## F10. Oversized output becomes evidence

`runProcess` has an `overflow: 'truncate'` mode that keeps the head and tail of each stream with a `…[N bytes truncated]…` marker and reports `truncated: true`; engine JSONL keeps the fail mode. The Codex validator (and the test fixture validator) use truncate mode at 1 MiB and record the result. A truncated validation counts as failed, so the repair loop asks the implementer to make the checks pass and reduce output. Git buffer overflows map to `git_output_limit` naming the command; the planning file listing uses a 64 MiB buffer and is capped at 20,000 entries before the existing character cap. Tests: process truncation (head, tail, marker, size bound), the Git error, and a runner test where a noisy first test is truncated, recorded with the marker, repaired and completes.

## F11. One protected-path rule

`src/domain/protected-paths.ts` holds `deniedSegments` and `protectedPath`; the policy engine, the change detector, the planner's file listing and the sandbox all use it (the sandbox re-exports it). The policy test now covers `.env` variants, `.npmrc`, `.netrc`, `.mcp.json`, `.agents`, `.pem` and `.key`, and a non-secret path such as `src/environment.ts` still reads.

## F12. Credential sealing serialized and change-aware

`seal()` calls are serialized in-process; a seal skips the write when the stored envelope already decrypts to the current runtime file; a torn read (the runtime still writing `auth.json`) is retried briefly rather than failing an otherwise successful engine run. Behaviour change: re-sealing unchanged credentials no longer produces a new ciphertext, which the vault test now asserts, together with five overlapping seals during atomic rotations persisting the newest token and a torn read being retried.

## F13. Worktree creation serialized per repository

`WorkspaceManager` chains `git worktree add` calls per repository path. Creation is cheap compared with engine calls, so wave parallelism is unaffected. Test: six concurrent item creations all succeed, are registered, and complete in request order.

## F15. Task list summaries

`GET /tasks` and `tasks list` return id, project, state, version, mode, branch, item count and commit or error; `GET /tasks/:id` keeps the full record. The API test asserts the list carries no agents, plan, request, criteria, workspace or outcome.

## F17. Data directory permissions and documentation drift

`accessToken` chmods the data directory to `0700` on every start, alongside the `0600` token, so a pre-existing wider directory is tightened. Tested with a directory and token deliberately widened between calls. The README's description of interrupted work was corrected with F3; the milestone checklist's test count is current.

## Verification

Run natively on macOS ARM64 with Codex CLI 0.160.1 installed, no credentials, at commit `968fc60` (all fixes F1 through F17 applied):

| Check | Result |
| --- | --- |
| `npm run check` | Pass: typecheck, 93 tests (80 after F2–F5), 0 failures, 0 skipped, production build |
| `npm run test:m2` | Pass, including the containment probe against the real Codex sandbox |
| `npm run test:m3` | Pass: three items, isolated worktrees, dependency integration, item and combined reviews, one final commit, original checkout unchanged |
| `tests/integration/dag-runner.test.ts` repeated | 17/17 pass in 7 consecutive runs with a 90 s per-test timeout |
| `tests/integration/sandbox-containment.test.ts` | Ran (not skipped) against the pinned Codex; passes |
| `npm run test:codex-protocol`, `npm run test:docker`, live fixtures | Not run (same reasons as in the review) |

`npm run check` was also run and passed before each of the nine commits.

Observation, recorded rather than hidden: one earlier full run of this verification, executed while the host's load average exceeded 30 because of unrelated applications, had the DAG test "rejects original HEAD divergence before final commit" time out after about 17 minutes, and three back-to-back DAG suite runs in the same window showed 1, 1 and 3 failures. The failure output of that window was not captured. Seven subsequent DAG runs with per-test timeouts, two further full checks, and both smoke fixtures passed once the load fell (around 11 to 18). The DAG fixtures use wall-clock delays and a 120 s validation timeout, so they are sensitive to host load; making them load-insensitive is a reasonable follow-up, and the episode is not attributed to any of the fixes above because none reproduced it.

## Documentation updated

- `README.md`: cleanup command and endpoint; planner shell decision; validation output truncation and `git_output_limit`; list summaries; data directory mode; leftover-worktree troubleshooting entry.
- `docs/DECISIONS.md`: nine bullets appended under "Pre-M4 review fixes — 2026-10-29".
- `docs/MILESTONES.md`: checklist entry extended; acceptance test count 93.

## Status

All findings F1 through F17 from `CLAUDE_REVIEW.md` are now addressed or explicitly decided (F8). M4 was not started. The protocol smoke, Docker suite and live fixtures were not run in any pass, for the reasons given in the review; they remain the next verification step before M4.

---

# Remaining non-live suites — 2026-10-30

The protocol smoke and the Docker suite had been left out of every earlier pass. Both were run at commit `533bf86` (all fixes applied), natively on macOS ARM64 with Codex CLI 0.160.1 and Docker Engine 24.0.6 (Linux ARM64) with Compose 2.22, host load average about 4 to 5, no credentials and no live model call.

| Check | Result |
| --- | --- |
| `npm run test:codex-protocol` | Pass: real pinned Codex JSONL and structured output; scoped shell and patch writes stay inside the owned directory and siblings are unchanged; outside, secret and Git denials; blocked command networking; no delegated or network tools; read-only review; opt-in connection check against the loopback fixture |
| `npm run test:docker` | Pass: image rebuilt from the current source during the run (creation time inside the run window; `dist/workspace/hidden.js`, `dist/workspace/conflicts.js`, `dist/domain/protected-paths.js`, `dist/domain/roles.js`, `workspaceScanLimit` and the cleanup route present in the image); health, unauthenticated setup, explicit project mount, non-root read-only service, task and event persistence across restart, idempotent retry; vault create and restore; deterministic M2 and M3 fixtures with real sandboxed validation inside the container; two concurrent real Codex protocol workers under the configured PID, CPU and memory limits; the suite removed its own containers and volumes |

The protocol fixture selected the keyring credential store with the real home directory, as noted in the review; no keychain prompt appeared and the fixture used only its fake environment key. The live fixtures (`test:codex-live`, `test:m3-live`) remain the only checks not run; they need the user's account and were excluded by instruction.

---

# Follow-up review of the fixes — 2026-10-30

An external review (Codex) of the fix commits reported three remaining defects. Each was verified before being changed; all three were real. Each fix is its own commit with regression tests. `CLAUDE_REVIEW.md` is unchanged.

## Findings as verified

1. **Unbounded line buffer** (`src/engines/process.ts`). The unfinished-line buffer `pending` was appended on every stdout chunk even without an `onLine` consumer, and had no bound of its own. Confirmed by code reading: a newline-free 2,000,000-byte output in truncate mode kept the whole stream in `pending` while the returned text was already truncated.
2. **Per-instance seal lock** (`src/security/credential-vault.ts`). The F12 serialization was an instance field, but `configuredVault()` constructs a new `CredentialVault` for every adapter call, so production callers never shared the lock. Confirmed by code reading.
3. **Truncation below the budget** (`src/engines/process.ts`). Reproduced: with `maxBytes: 1000`, 600 bytes of stdout returned `truncated: true` and a `[0 bytes truncated]` marker, because each stream's head was capped at half the budget regardless of the total. A passing validation with 600 bytes of output would have counted as failed.

## Fixes

| Commit | Item | Change |
| --- | --- | --- |
| `3593edc` | 3 | Streams are retained in full while the combined stdout/stderr total is within the budget. On overflow, each stream keeps a head (a quarter of the budget) and a tail (an eighth), cut on UTF-8 code-point boundaries; the marker reports exactly written minus retained; the overflowing chunk is retained before the split so the head is never empty; retained evidence stays within the budget. |
| `a0fabf7` | 1 | The line buffer exists only when an `onLine` consumer is supplied, and an unfinished line longer than the budget fails closed with `output_limit` in both overflow modes, so engine JSONL parsing stays fail-closed. Without a consumer, oversized newline-free output is simply truncated. |
| `1a659d5` | 2 | The seal lock is a module-level map keyed by the canonical encrypted-file path, shared by every instance targeting the same vault; idle entries are removed. |

## Regression tests added

- Output below, at and above the budget (0, 1, 600, 999, 1000 kept whole; 1001, 1500, 5000, 300000 truncated with head, tail and exact accounting, retained bytes within the budget).
- Combined stdout and stderr under and over the shared budget, with accounting across both streams.
- Two-byte and four-byte newline-free output: no replacement characters, no partial code points, exact accounting; exact-budget multi-byte output kept whole.
- Streaming consumer: whole lines in order, blank lines skipped, the final unterminated line delivered on close; newline-free output beyond the budget truncated without a consumer and rejected with one in both overflow modes; two thousand short lines streamed while retained text stays within the budget.
- Four separate `CredentialVault` instances on the same files sealing concurrently during atomic rotations: never more than one seal in flight (instrumented), newest credentials restored by unlock. Synthetic credentials only.

## Verification

Run natively on macOS ARM64 with Codex CLI 0.160.1 and Docker Engine 24.0.6 (Linux ARM64), at commit `1a659d5` (all three fixes applied), host load average about 9, no credentials and no live model call:

| Check | Result |
| --- | --- |
| `npm run check` | Pass: typecheck, 99 tests (93 before this pass), 0 failures, 0 skipped, production build; also passed before each of the three commits |
| `npm run test:m2` | Pass, including the containment probe |
| `npm run test:m3` | Pass: three items, isolated worktrees, dependency integration, item and combined reviews, one final commit, original checkout unchanged |
| `npm run test:codex-protocol` | Pass: scoped shell and patch containment, denials, blocked networking, read-only review, loopback connection check |
| `npm run test:docker` | Pass: image rebuilt during the run (creation time inside the run window); vault create, restart and restore; real-runtime credential save; M2 and M3 fixtures in the container; two concurrent protocol workers under the configured limits; health, mount, non-root, persistence and idempotent retry |
| Live fixtures | Not run, by instruction |

## Remaining limitations

- Truncation keeps at most three eighths of the budget per stream (a quarter head, an eighth tail), so two noisy streams together retain at most three quarters of the budget plus two short markers; the remainder of the budget is deliberately unused so retained evidence never exceeds it.
- A streaming consumer sees every complete line even in truncate mode; only the retained text is bounded. That is the intended contract for evidence, but it means the consumer, not `runProcess`, must bound any per-line work.
- The seal lock is per process. Two DevAgents service processes on one data directory are already prevented by the service lock, so no cross-process lock was added.
