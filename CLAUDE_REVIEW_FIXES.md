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

## Still open

Findings F7 through F13 and F15 through F17 in `CLAUDE_REVIEW.md` remain as described there. M4 was not started.
