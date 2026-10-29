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

## Not changed

The remaining findings in `CLAUDE_REVIEW.md` (F2 through F17) are untouched. M4 was not started.
