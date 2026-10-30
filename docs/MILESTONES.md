# Milestone checklist

## M0 — Compatibility (partially verified)

- [x] Current official Codex/Claude execution and authentication documentation.
- [x] Installed versions, native platform and Docker ARM64 startup.
- [x] Mastra suspension and storage/runtime recreation probe.
- [x] Native Codex filesystem sandbox probe with harmless sentinel files.
- [x] Dedicated container API-key authentication recognized by Codex.
- [x] Real Codex coding-engine fixture passed using ChatGPT sign-in on 2026-10-29 (earlier API-key request was blocked by quota).
- [x] Enabled shell/patch tools and command network isolation probed on native macOS and Docker Linux ARM64.

## M1 — Foundation (implemented)

- [x] Strict TS, locked dependencies, Zod configuration/input schemas.
- [x] SQLite schema versioning, transactional tasks, append-only events.
- [x] Authenticated CLI/API, existing project registration, idempotent submission.
- [x] Mode wait, explicit mode, validated DAG plan, approval/rejection/cancellation.
- [x] Six built-ins and configuration-only custom roles/overrides.
- [x] Separate provider/model/engine configuration seams.
- [x] Path checks, initial policy helpers and secret-redacted telemetry.
- [x] Compose, non-root execution, healthcheck, limits and restart smoke test.
- [x] Native tests and documentation.

## M2 — Single-engine vertical slice (implemented; live fixture verified)

- [x] Worktree creation tested against dirty user checkout.
- [x] Dedicated Codex login command and setup diagnostics.
- [x] One-command Docker startup with guided ChatGPT/API-key selection, hidden key entry and encrypted persistent reuse.
- [x] Saved-login status, optional bounded connection test, actionable failures and noninteractive reuse.
- [x] OS keychain master key, authenticated encryption, legacy migration, tmpfs runtime and restart-unlock tests.
- [x] Codex adapter: normalized streaming, timeout and child cancellation.
- [x] Dynamic Tech Lead using registry and scoped project context.
- [x] Pinned runtime shell/patch and validation containment tested; unsupported tools disabled.
- [x] Execute/test/independent review/bounded repair/local commit loop.
- [x] Fake-engine end-to-end tests and opt-in real Codex fixture command.
- [x] Authenticated real model fixture passed with ChatGPT sign-in: planning, implementation, actual tests, independent review and local commit; original checkout unchanged.
- [x] Durable execution runs, evidence and worktree reconciliation metadata.

## M3 — Dynamic multi-agent (implemented; live container fixture verified)

- [x] Tech Lead produces a bounded DAG with role assignments, owned paths and explicit integration validation.
- [x] Deterministic ready waves respect dependencies, global concurrency and per-role limits.
- [x] Config-only custom specialist exercised end-to-end in parallel worktrees.
- [x] Private dependency checkpoints and isolated item branches; original dirty checkout preserved.
- [x] Item validation/review, serial three-way integration, explicit bounded conflict repair.
- [x] Combined validation/review/repair gate the final local commit; original HEAD divergence blocks completion.
- [x] Append-only item/run/worktree/commit evidence, CLI/API item progress, safe interruption recovery.
- [x] Sibling cancellation/drain, blocked dependents, ownership checks and custom merge-driver refusal.
- [x] Native and Linux ARM64 Docker deterministic M3 fixtures with actual sandboxed validation.
- [x] ChatGPT-authenticated three-item M3 fixture: parallel workers, dependency integration, actual tests, independent item/combined reviews and final local commit; original checkout unchanged.
- [x] Planner schema compatibility, explicit review stages and invalid-path/command regression checks.
- [x] Pre-M4 review fixes: value-only redaction for model prompts and task data; plan-time executability checks shared with execution; hidden-file integrity around implementation; shutdown recorded as failed with reason; bounded, collapsing sandbox scan; content-based conflict resolution; explicit worktree cleanup; malformed-rejection, output-truncation, protected-path, sealing, worktree-creation, list-summary and data-directory hardening.
- [x] Scoped shell/patch containment and two concurrent runtime fixtures under Compose CPU/memory/PID limits; Linux exact-file writes fail before inference.

## Post-review acceptance gate

- [x] Authenticated M2 and M3 reruns passed on 2026-10-30 after the owner's authorization, against `main` at `db95711cb012a7824c5fdfed7a226a4cb5592b7f`. Rebuilt with `./devagents start --auth saved`; reused the saved ChatGPT account. Environment: Docker Linux ARM64, Node v24.18.0, Codex CLI 0.160.1.

Commands run sequentially against that rebuilt service:

```sh
docker compose exec -T devagents node scripts/m2-smoke.mjs --live
docker compose exec -T devagents node scripts/m3-smoke.mjs --live
```

Both exited successfully on their first attempt. M2 verified planning, implementation, real sandboxed validation, independent review and a local commit. M3 verified three items, two parallel workers, dependency integration, real sandboxed validation, independent item/combined reviews and the final local commit. Both fixtures verified that their original checkout remained unchanged and cleaned up their temporary projects. This closes the post-review live gate for the named baseline; it does not claim native authenticated or AMD64 acceptance, or acceptance of future U2/M4 code. The documentation-only handoff update did not repeat the already recorded non-live suites.

## U1–U3 — Local browser UI (U1 and U2 implemented; U3 planned)

Ownership clarified by the owner on 2026-10-30: Codex handles implementation fixes, including frontend bugs; involve Claude when new design is needed. Product scope and acceptance are in [the frontend brief](FRONTEND_BRIEF.md); start with [the implementation instructions](../IMPLEMENTATION_PROMPT.md) and [UI implementation plan](UI_IMPLEMENTATION_PLAN.md). The post-review live gate is satisfied for the baseline above. U2 was implemented on 2026-10-30 from the handoff in the implementation plan; U3 and M4 remain separate increments.

- [x] Product brief, implementation handoff and roadmap alignment.
- [x] Full screen/state design: Overview, Teams, Projects, Tasks and Settings. Direction A was chosen with its Overview restructured for density. The selected source boards live in `design/ui/` (see its README).
- [x] U1: same-origin app shell, protected browser session, real read-only progress/history/results, safe content rendering and browser/CLI compatibility. Verified natively with 9 Playwright workflows against the labelled fixture (sign-in, overview, list, completed/approval/failed/cancelled/mode-wait detail, hostile content, disconnect and reconnect, narrow screen, sign-out) plus API/session regression tests; Docker smoke covers the in-image UI and bootstrap exchange.
- [x] U1 status review fixes: category-first overview queries, state filters before pagination, history-derived plan approval, and bounded structured facts alongside evidence previews. Three new API tests and four new browser regressions. The full check passed 107 tests; all 13 browser workflows passed across the full run and a targeted rerun after correcting an exact-text test selector. Docker/protocol/standalone smoke suites were not repeated for that status-only fix pass.
- [x] U2: persisted reusable teams (schema 3, append-only revisions), template/custom members, server readiness diagnostics, archive/duplicate, versioned project defaults, atomic submission snapshots with concrete engine/provider/model, frozen runner configuration and legacy compatibility; browser list/editor/default-team controls following `design/ui/A-Teams`. Verified with 13 new deterministic tests (schema-2 upgrade, CRUD/revisions/conflicts, precedence/idempotency/archived defaults, pinned vs runtime-default model, frozen roster through edits/archive/config change/awaiting mode/restart recovery, excluded agent in single-item and DAG plans, API routes with missing CSRF and foreign origin) and 5 new Playwright workflows (list/readiness/filters, template+custom creation to ready, forbidden grants and disabled options, stale save/duplicate/archive/restore/project default conflicts, team labels and keyboard use on a narrow screen). Limits: `model: default` is recorded as unpinned unless `defaultModel` is configured; choosing a team in the browser waits for U3 submission; Claude/non-OpenAI members save only as drafts until M4.
- [x] U3: guided setup, project registration, task submission/mode, version-bound plan approval, cancellation and safe completed-task diff inspection. Delivery scope and verification below. Browser cleanup remains deferred.
- [x] U1 browser workflow/security tests, responsive layout, regenerable screenshots in ignored `test-results/ui-screenshots/` and native/Docker packaging. Repeat for U2 and U3.
- [x] U2 as above (18 browser workflows pass in full; Docker smoke re-run for the in-image UI).
- [x] Codex U2 review fixes F1–F5 plus the team-backed DAG snapshot test (`CLAUDE_REVIEW_U2_FIXES.md`): readiness reuses plan-validation role rules, template copies are complete under a 192,000-byte team budget, and the editor keeps typed grants, ignores stale readiness responses and keeps Restore/member selection usable on archived teams. `npm run check` passed 122 tests; all 21 browser workflows passed. Docker/protocol/M2/M3 standalone suites were not repeated (no runtime, sandbox or adapter code changed).
- [x] U2 follow-up F6: template/custom additions are disabled and guarded while saving, including menus already open. The regression failed against the old UI, then passed with the fix and verified additions persist after saving resumes. `npm run check` passed 122 tests (no skips), typechecks and build; the final browser run passed all 22 workflows. The first browser run had an existing F2 timeout and an ambiguous F6 status locator when a connection banner appeared; the F6 locator now selects the save notice, and the full rerun passed in 37.2 seconds. Browser runs used an empty temporary credential runtime. U2 is accepted with the existing limitations; the mode-default idempotency follow-up remains separate. No authenticated fixtures, credential inspection, Docker rebuild or push was performed for this fix.
- [x] U3 as above; no new engine integration or authenticated model calls.
- [x] U3 review (`CLAUDE_REVIEW_U3.md`): accepted with one P2 fix applied, diff and response redaction now use the store's full secret list (configured provider keys as well as the environment heuristic). `npm run check` passed 132 tests; all 32 browser workflows passed. Five P3 notes remain open.

U1 is the first integrated UI increment before M4. Keep U2/U3 and M4 as separately reviewed work; a team editor must not claim unavailable engines or capabilities work.

## Later
- [ ] M4: Claude adapter, per-agent routing, shared engine fixtures.
- [ ] M5: authorized GitHub integration, recovery hardening, multi-arch CI/release.
- [ ] Follow-up: local inference and a validated tool harness.

## Next commands

```sh
npm ci
npm run check
npm run spike:mastra
node scripts/sandbox-spike.mjs
npm run test:docker
npm run dev
# Separate terminal:
npm run cli -- doctor
npm run cli -- projects add my-project /absolute/path/to/existing-checkout
```

Before the M2 live fixture, configure the dedicated account with `npm run cli -- auth codex`, or use `auth codex --api-key-env OPENAI_API_KEY`. M2 queues planning/execution after explicit mode selection. Use `tasks show` and `tasks evidence` to follow the result.

## Pre-U3 submission retry fix — 2026-10-30

Completed: mode defaults resolve only after request identity is checked, inside task creation. New fingerprints distinguish explicit and omitted modes; old resolved-input fingerprints remain readable without rewriting existing request records. Their historical explicit/default ambiguity is documented in `DECISIONS.md`.

Verification: `npm run check` passed **127 tests, no skips**, backend/UI typechecks and production build. Deterministic M2 and M3 fixtures passed with real sandboxed validation and unchanged original checkouts. Five new tests cover default changes, mode selection/restart, legacy records, conflicting input and transactional rollback. Browser/Docker/protocol suites were not repeated for this persistence/service-only change; no authenticated calls or real credential inspection occurred.

## Acceptance commands

- `npm run check`: 132 tests, backend and UI typecheck, production build of service and UI (one real-sandbox containment test runs only when the pinned Codex is installed).
- `npm run test:m2`: deterministic planning/implementation/review with real sandboxed validation and a local commit.
- `npm run test:m3`: deterministic three-item DAG with isolated branches, dependency integration, actual sandboxed validation and a combined commit.
- `npm run test:m3-live`: opt-in authenticated three-item fixture; equivalent container command passed with saved ChatGPT sign-in. Native authenticated execution remains unverified.
- `npm run test:codex-protocol`: real pinned Codex shell/patch execution and structured events against a loopback model fixture; no account/API calls.
- `npm run test:docker`: isolated service persistence plus M2, M3 and protocol fixtures under Linux container restrictions.
- `npm run test:codex-live`: opt-in authenticated native fixture. The equivalent container command passed with ChatGPT sign-in; native authenticated execution remains unverified. See README.

M3 supports one active top-level request with bounded parallel work items, text changes and read-only Node/npm validation. Linux/Docker writes require directory-subtree grants; exact-file writes are rejected when the plan is validated, before approval, and again before model execution because of a pinned-runtime limitation. Scheduling uses deterministic waves, not immediate dispatch when a slot frees. Local inference, multiple engines, cross-request concurrency, generated build output policies and external actions remain later work.

## Verification history notes

Detailed completed review reports are retained in Git history; current constraints and fixes are recorded here and in `DECISIONS.md`. The 2026-10-29 live passes predate the review fixes; the 2026-10-30 reruns above verify the post-review baseline. During one pre-UI verification window, high host load coincided with a DAG timeout and failures whose output was not captured; subsequent repeated DAG runs and full checks passed. The cause was not established, and wall-clock-sensitive fixtures remain a known testing limitation. Follow-up fixes covered process output bounds and credential seal locking shared across instances.

## U3 browser workflows delivery — 2026-10-30

Implemented from `c86d342` on local `main`, in ordered commits for registration, submission/default projection, retry identity, task decisions, completed-task diff and guided setup, followed by regression hardening. The approved U3 boards extend the existing U1/U2 components and polling/security contract. No implementation of M4, model-pinning changes, authenticated fixture runs, real credential inspection or push is included.

- Registration preserves input and service errors, including actionable container-path guidance. The submit form exposes ready teams/defaults and returns the frozen team/revision; it stays usable without sign-in, with a warning.
- One immutable key/payload per attempt survives dropped responses, duplicate clicks, reload, session renewal and an actual service restart. Changed payloads conflict. Abandonment is explicit; a fresh submission is deliberate. Task input is kept only in tab session storage, with no authentication/provider-secret fields. Closing the tab loses that recovery state.
- Missing mode requires a choice. Shared header/Plan actions bind approval to the displayed version and require a new decision after 409. Rejection cancels; queued/running cancellation preserves worktrees, and committing refuses cancellation. Resubmission copies request/criteria only.
- Diff reads completed-task recorded base/final objects after ownership checks; no arbitrary client paths/refs, external diff or textconv. Caps: 64 KiB/file, 256 KiB total text, 200 files, 256 KiB listing and 1 MiB/file read. Values are redacted before display truncation; over-read files are entirely omitted. Binary/protected/truncated/empty/unavailable/not-offered are distinct. Patch download and browser cleanup remain disabled.
- Guided setup uses secret-free status and copyable terminal commands; no browser credential entry or automatic paid test. Synthetic status in the browser fixture avoids inspecting a developer's real provider profile.

Verification on the final implementation:

- `npm run check`: 131 tests passed, no skips, backend/UI typechecks and production build passed.
- `npm run test:ui`: 32 workflows passed, including every U1/U2 workflow and 10 U3 workflows. The end-to-end fixture registers a project, selects a ready team, approves a displayed plan after testing stale-version recovery, observes validation/review/commit, inspects the diff and confirms the original checkout is unchanged. Additional coverage includes dropped responses/reload/session renewal, actual API/store restart, cancellation, unavailable runtime/login, hostile diff text and the explicit unavailable/empty/binary/truncated states.
- API and Git regressions cover missing CSRF, foreign Origin/Host, forged diff metadata/query identity, missing objects, protected/binary files, output caps, redaction and disabled Git helpers. Existing frozen-team, model-default and idempotency compatibility tests remain passing.
- `npm run test:m2` and `npm run test:m3`: deterministic fixtures passed using the real command sandbox and unchanged original checkouts.
- `npm run test:docker`: freshly built image passed UI/session protection, setup with synthetic credentials, explicit project mount, persistence/idempotency across restart, sandbox containment, deterministic M2/M3 and two concurrent real-runtime protocol fixtures against a loopback test server. No paid request.
- Representative desktop and 390 px screenshots were generated and inspected in ignored `test-results/ui-screenshots/` (registration errors, submission, accepted result, approval, diff and guided setup). They are development evidence, not checked-in visual baselines.

Live acceptance is not claimed for this new increment. The earlier authorized live baseline remains recorded above; any further authenticated run needs separate authorization. Browser cleanup still requires its preview/revalidation/ownership follow-up before it can be enabled.

## U3 remaining review notes F2–F6 — 2026-10-30

All five P3 findings from `CLAUDE_REVIEW_U3.md` are addressed after the configured-secret fix:

- F2: Overview's setup note follows missing/locked runtime sign-in or an empty project list; a configured workspace no longer receives an unconditional prompt. Teams remain optional.
- F3: Diff failures retain fail-closed 409 responses and emit bounded, redacted diagnostics with task ID, read phase and error code. Synthetic missing-runtime and secret-bearing process errors exercise the logging path.
- F4: A 4 MiB aggregate patch-read budget supplements the 1 MiB/file limit. Oversized reads consume their reservation even if all text is omitted; remaining files become explicitly truncated. This limits captured output, not total Git computation time. Existing display caps are unchanged.
- F5: The real status reporter and browser fixture share an explicit five-field limits projection; provider/configuration fields no longer appear under fixture limits.
- F6: The browser test for binary, truncated, empty and unavailable diffs now uses real Git commits and the authenticated HTTP endpoint, including hostile text and redaction. No diff-response interception remains in that test.

Verification: `npm run check` passed 134 tests, typechecks and build; `npm run test:ui` passed all 33 workflows, including every U1/U2 workflow. The updated diff screenshot was inspected. The six-test diff suite was also rerun after extending the log-redaction assertion. Docker, protocol and M2/M3 suites were not rerun for this follow-up: it changes UI/status projection, diff read limits/diagnostics and fixture coverage, not engine execution, sandboxing or packaging. No authenticated fixtures, credential inspection or push. The original review report is unchanged.
