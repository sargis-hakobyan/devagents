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

## Production Mastra orchestration — 2026-10-31

- [x] Pinned Mastra core/LibSQL promoted from spike-only development dependencies to production dependencies.
- [x] Versioned task workflow with worktree/planning/execution steps and persisted mode/plan-approval gates.
- [x] Mastra repair loops and bounded parallel worker waves retain domain ownership, concurrency, review and integration policy.
- [x] Reference-only snapshots, redacted framework errors, no automatic side-effect retries/replay, child cancellation/drain and legacy approval compatibility.
- [x] Regression coverage for runtime recreation, stale/racing approvals, duplicate scheduling, cancellation, storage failure, secret redaction and abrupt process death.
- [x] Verification: `npm run check` (161 tests, backend/UI typechecks and build), `npm run test:ui` (35 workflows; accepted-task and completed-diff screenshots inspected), native deterministic M2/M3, and `npm run test:docker` all pass. Docker verifies production Mastra dependencies, persisted mode waits across restart, deterministic M2/M3, containment and two concurrent real-runtime protocol fixtures. No authenticated model fixtures were run.

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

## Simplified startup and provider setup — 2026-10-30

Delivered before M4:

- Short README with one entry command, purpose and setup links; detailed material moved to `REFERENCE.md` and `SETUP.md`.
- Cached local-image startup with Browser (default), Terminal and Later routes, direct setup links, saved-connection reuse and explicit setup reopening.
- Session-owned browser Codex device sign-in and write-only API-key entry, shared with terminal authentication. Secure existing storage, bounded output/lifetime, cancellation and execution exclusion are retained. No automatic model test.
- Host launcher project selection, Git validation, additive Compose mounts and registration without manual YAML; user overrides preserved, conflicting mounts refused, restart failure rollback and maintenance admission checks.
- Recommended saved team and first-task navigation using the existing frontend components and server policies. Claude and local models remain disabled; M4 is unchanged.

Verification: `npm run check` passes 140 tests, backend/UI typechecks and build; `npm run test:ui` passes all 34 workflows, preserving U1/U2/U3 coverage. Deterministic native M2/M3 pass. The Docker suite passes encrypted synthetic browser-key save/reuse across restart, authentication/session checks, sandbox containment, deterministic M2/M3 and two concurrent real-runtime protocol fixtures against a loopback server. Upload-race admission and cancellation-drain checks have regression coverage. The connected setup screenshot at 390 px was inspected in ignored `test-results/ui-screenshots/`.

Limits: first start still builds locally and requires Docker plus a desktop OS credential store. Public prebuilt-image distribution remains release work. Host folder mounting stays in the terminal. Tests do not claim live acceptance of the new device-login UI, paid model access or a real OS keychain interaction; all credentials used in this increment's tests are synthetic. No authenticated fixture or push was performed.

## Startup menu keyboard navigation — 2026-10-30

The host setup menu supports up/down arrows, wraparound, number shortcuts and Enter, without requiring host Node.js. Limited terminals retain numbered input; cancellation restores the terminal settings. The existing authentication prompts are unchanged.

Verification: launcher and plain-menu regression tests passed; eight real pseudo-terminal checks covered default selection, arrows/wraparound, numbers, invalid keys, EOF and SIGINT with restored terminal settings. Shell syntax checks passed. Backend, browser and Docker suites were not rerun for this host-menu-only change. No credentials, model calls or push.

## Arrow navigation throughout terminal setup — 2026-10-30

Provider selection, optional connection testing, the post-setup project choice and mount confirmation now all support arrows and Enter. The Node CLI uses a reusable selector; host prompts reuse the startup selector. Saved login, skipping a model test and declining a mount retain safe defaults. Only project names, paths and hidden API-key entry remain free text; limited terminals keep numbered fallback input. Noninteractive commands and explicit flags are unchanged.

Verification: `npm run check` passed 143 tests, typechecks and production build. Interactive saved-login and test-skip menus passed in both native and isolated network-disabled Docker terminals with synthetic status and no credentials/model requests. Arrow/number/default selection, cancellation, signal-listener cleanup and raw-mode restoration have regression coverage. Shell syntax checks passed. Browser and full Docker/M2/M3 suites were not repeated for this terminal-input change. Nothing pushed.

## Project-name normalization before mounting — 2026-10-30

Fixed a macOS locale mismatch where the launcher's shell range accepted `TestProject` but the backend's ASCII ID schema rejected it after mount confirmation. The launcher now normalizes uppercase names and spaces to lowercase IDs/dashes under the C locale, validates before asking for a path, retries invalid names and displays the generated ID before confirmation. Existing IDs/mappings are preserved; conflicts are refused with specific errors.

Verification: reproduced the old acceptance under `en_US.UTF-8`; six targeted launcher/setup/mount tests passed, including normalization against the real backend schema and conflicting mounts. Typecheck, production build and shell syntax checks passed; the compiled mount CLI reports a specific invalid-ID error. No user checkout, credentials or running service were accessed or changed. Full execution/browser/Docker suites were not rerun for this input-validation fix. Nothing pushed.

## Preselected starter team — 2026-10-30

Service startup now creates one persistent **Starter team** from the bundled Tech Lead, Developer, QA Engineer and independent Code Reviewer roles. New projects select it automatically when ready; existing projects with untouched team settings receive it on upgrade. Custom defaults, deliberately cleared defaults, edited/renamed/archived teams and submitted-task snapshots remain unchanged. Setup displays the saved selection and no longer creates teams by mutable name. Users can customize or replace the starter through the existing Teams editor.

Verification: `npm run check` passed 148 tests, backend/UI typechecks and production build; all 34 browser workflows passed. New regression tests cover repeated initialization/reopen, new project defaults, a completed deterministic starter-team task, frozen model/roster snapshots, custom and cleared defaults, archives and unsupported engines. The full Docker suite passed, including production startup, persistence/restart, sandbox containment, deterministic M2/M3 and concurrent loopback protocol fixtures. The updated narrow setup screenshot was inspected. No real credentials, authenticated model calls or push.

## Optional extra execution rules — 2026-10-30

- [x] New tasks default to `devagentsRules: false`; `DEVAGENTS_RULES=true` enables additional restrictions through native configuration or Docker/.env.
- [x] Policy is frozen atomically at submission after idempotency lookup; old tasks keep strict behavior. Planning, single-item and DAG execution, and validation use the same snapshot.
- [x] Default mode accepts project-specific executable/argv validation, allows generated output and safe internal package links, and treats role/item paths as advisory within the managed worktree. Strict mode restores the command allowlist, role scopes, read-only validation and ignored-file checks. Agent engine rules remain loaded in both modes.
- [x] Settings, task details and the team editor explain the effective policy. README stays short; setup and reference documents describe activation and boundaries.
- [x] Verification: `npm run check` (154 tests, backend/UI typechecks and build), final targeted plan/policy/adapter/readiness regressions, 35 browser workflows, native deterministic M2/M3, native loopback Codex protocol and the full Docker suite. The Docker protocol runs two workers concurrently and exercises both policy modes. Screenshots inspected in ignored `test-results/ui-screenshots/execution-policy-{settings,task}.png`.
- [ ] Authenticated acceptance of the new policy mode was not run; no real credentials or user project were inspected. Claude and other engine adapters remain deferred to M4.

Limits: this is an optional extra-policy layer over the existing engine sandbox, not a copy of a desktop engine session. Worktree/credential and read-only planning/review boundaries, network isolation when extra rules are on, no deployment authorization, structural validation, independent review and resource limits remain. Locked npm/pnpm dependencies are now installed by the separate environment preparation step described below; other tools need a compatible runtime. With extra rules off, ignored/generated files can influence validation without appearing in the commit; planned item scopes no longer constrain writes inside each isolated worktree.

## Project environment preparation — 2026-10-31

- [x] Mastra preparation gate after plan approval, plus per-worker and combined-worktree checks before implementation and validation.
- [x] First environment adapter: root Node projects and npm/pnpm 10 workspaces, runtime checks, frozen lockfiles, metadata fingerprints and re-preparation after dependency changes.
- [x] Docker Node 24.22.1, bundled pnpm 10.34.9, and validation-executable preflight. Missing tools/packages stop as environment failures without code-repair attempts.
- [x] Credential-free, metadata-only dependency download sandbox; no lifecycle scripts, repository hooks, original-checkout dependencies or shared mutable node_modules. Copy-based package imports and checked internal links.
- [x] Preserve async command output and nonzero status under the offline Linux sandbox with the newer Node runtime.
- [x] Regression coverage: approval ordering, cancellation, no-repair environment failures, input changes, dependency-free projects, hostile links, runtime/lockfile failures, workspace metadata, real npm/pnpm downloads and workspace links against a loopback registry, preserved command output/status and blocked validation networking.

Limits: private registry credentials, lifecycle builds, arbitrary Node/package-manager downloads, other provisioning adapters, dependency services and general failed-task resume remain separate work. A prepared environment enables real validation; it does not attest the correctness of the generated change or guarantee all project checks pass. M4 was not started.

Verification: 168 tests plus typechecks/build, 35 browser workflows, native preparation/M2/M3, the full Docker suite, and a final Docker preparation/M2/M3 pass after the dependency-free cache correction. No authenticated model calls or pushes.

## Agent-managed setup — 2026-11-01

- [x] Default rules-off setup delegates actual project preparation to the assigned coding agent after approval, rather than rejecting unfamiliar tooling or skipping scripts.
- [x] Network-enabled engine sandbox, persistent per-worktree tool HOME/PATH, lifecycle scripts and package-manager hooks/version selection. Original checkout, credential and Git boundaries retained.
- [x] One environment recovery per worktree for missing-tool/dependency validation errors, separate from code repair; full validation rerun and per-pass source immutability checks.
- [x] DAG worker/integration setup uses the frozen roster and per-agent concurrency slots. Setup edits enter the existing review and final commit.
- [x] Extra-rules mode retains restricted locked Node preparation and offline coding/validation.

This supersedes the earlier default-mode preparation restrictions above. Private authentication, persistent service provisioning, privileged host installs and unsupported engine integrations are not added. Failed-task resume and M4 remain separate work.

Verification: `npm run check` passed 175 tests plus backend/UI typechecks and the production build. All 35 browser workflows passed on the final run; the task/result screenshot was inspected. Native environment preparation, real-runtime protocol, deterministic M2/M3 and the complete Docker suite passed, including two concurrent protocol workers. Only synthetic local/loopback fixtures were used; no authenticated model calls, real failed-task rerun or push.

An initial browser diff assertion timed out during a host load spike; the isolated test and full browser rerun passed. Docker smoke exposed two fixture assumptions: async child-test output under the offline sandbox, and a runtime shim that recursively invoked the relative `process.execPath` returned inside Linux. The fixtures now use an awaited in-process network test and the service's absolute Node path. The final Docker run passed with those corrections.

## Large-project compatibility — 2026-11-02

- [x] Removed the changed-file 512 KiB gate; regression covers a large lockfile, full fingerprinting and isolated commit.
- [x] Default-mode sandbox scans handle dependency trees beyond 200,000 entries while retaining protected-path/link checks and cancellation; verified on a 316,879-entry real workspace.
- [x] Configurable Docker RAM/CPU/PID limits with larger defaults; longer agent/validation budgets and three bounded code repairs by default.
- [x] Cumulative engine output is streamed without failing at the retained-output budget. Validation prompt previews retain all commands/statuses and redact values before shortening.
- [x] Setup uses prerequisite probes, preserves baseline failure notes for implementation/review and offers bounded setup recovery.
- [x] Reviews receive bounded supplementary implementation command evidence from the same worktree, including repair checks, separately labelled from claims and mandatory validation.
- [x] Authenticated three-item DAG fixture: independent parallel specialists, dependent work, item and combined reviews, real validation and one final commit; fixture checkout unchanged.
- [x] Authorized large-monorepo mailbox ticket completed as task `e108a85b-5f36-4c19-97b1-cc5a9f3884f7`, commit `bc2eb6f112f395d9bd27e8c1ce5cd4c02192350b`: four declared validation commands passed, independent reviewer approved, zero code repairs. Original checkout HEAD/status unchanged. Completed task branch retained after managed worktree cleanup.
- [x] Authorized “Meine Aufträge” ticket completed as task `d5619d45-5844-4b44-9d2f-86e6264b9510`, commit `f5d7b50bbd5803d7e9c1c0c8963a8114ff610b90`: four declared validation commands passed, independent reviewer approved, one repair cycle. The developer provisioned temporary PostgreSQL 17 and ran all three targeted database tests without skips, then stopped it. Original checkout HEAD/status unchanged; final branch retained after managed cleanup.

The first live attempt stopped on an existing UI test-loader defect during setup. The setup/implementation handoff was corrected before the successful rerun. Reclaiming generated dependencies from finished attempts was necessary because the local Docker disk was nearly full; source and final commits were preserved. This is real local ticket verification, not deployment or browser acceptance against staging. M4 remains separate.

The second ticket's final reviewer did not receive the supplementary PostgreSQL command results and incorrectly retained a “database tests skipped” qualification, despite their successful execution. That evidence gap prompted the final handoff correction; the original task evidence and reviewer output remain unchanged.

Regression verification before the final handoff correction: `npm run check` passed 180 tests, backend/UI typechecks and build; all 35 browser workflows passed and the completed-task screenshot was inspected. Native deterministic M2/M3 and the full rebuilt Docker suite passed, including real-runtime protocol/containment and concurrent-worker checks. The authenticated M3 fixture also passed. The handoff correction adds two regression tests and assertions for isolated DAG worker evidence; `npm run check` passes 182 tests.

Final handoff-corrected build: all 35 browser workflows, native deterministic M2/M3, the full Docker suite and the authenticated three-item M3 fixture passed again. The running service was rebuilt and restarted with these changes. Both completed real-ticket diffs remain available after worktree cleanup. Nothing was merged or pushed, and no staging deployment/browser acceptance was performed.

## Environment-limitation reporting — 2026-11-02

Implemented the owner's rule that checks blocked by the environment are reported, not retried: plan `manualChecks`, implementation and review `limitations`, merged into `outcome.limitations` for single-item and DAG tasks, with prompt instructions for planner, implementer and reviewer and browser rendering in the task header, Result tab, Plan tab and task list. Regression coverage: schema bounds and merging (unit), a single-item task that completes with two reported checks and zero repairs while a failing test still repairs, a DAG task with worker and combined-review reports, and a browser workflow through the fixture's `[blocked-check]` marker. The Codex browser-runtime work-in-progress was stashed, not merged.

## Limitation reporting review fixes — 2026-11-02

Codex review findings F1–F4 fixed with regression tests (reports surviving repairs and item reviews, reviewer copy-forward removed in favour of an orchestrator ledger, evidence-grade redaction of display prose, a registered model-schema inventory with `$defs` traversal); F5–F8 addressed by revising the dependency-store and cleanup handoffs before implementation. Verification counts are in the commit message; Docker was not rebuilt for these commits.


## Limitation reporting follow-up — 2026-11-02

Implemented R1–R4 from `CODEX_REVIEW_LIMITATIONS_FIXES.md`: bounded identity deduplication and explicit counts, redaction before handoff and in legacy display projections, setup-report capture, failed/cancelled outcome retention, and run/attempt provenance. Result, Overview and task-list counts no longer include a generated omission notice. R5–R9 are handoff revisions only; shared dependency storage and cleanup remain unimplemented.

Backend and UI compiler checks passed during the follow-up. Added regression tests remain unrun by owner instruction; no runtime/UI, Docker, protocol, M2/M3 or authenticated verification is claimed. Changes are prepared for Claude's independent review.


## Task compaction and disk-failure containment — 2026-11-03

Implemented a task-page/CLI compaction preview and confirmation for ignored dependency directories, with bounded expiring inventories, tracked-file protection, managed ownership, a durable audit intent and terminal/drained lifecycle checks. Added preparation disk headroom and runtime low-space checks, Overview storage warnings, preservation of the original SQLite failure and containment of failed final checkpoints. Mastra remains the execution/persistence owner; compaction never rewrites its snapshots.

Backend and UI typechecks passed. Added storage-full, compaction, drain and UI-confirmation regression source remains unrun at the owner's request. Nothing was deployed, rebuilt, restarted or compacted in the live service. Shared dependency storage and the broader removal/retention handoffs remain future work.

## Completed-task resource retention — 2026-11-03

Completed tasks now compact regenerable dependencies, private worktree tool caches and owned legacy run scratch automatically after workflow drain and during recovery. Clean completed worktrees are removed without force; result branches, commits and task/workflow evidence remain. Dirty worktrees and unknown ignored files are retained; failed/cancelled environments require explicit compaction. `compactCompletedTasks` / `DEVAGENTS_COMPACT_COMPLETED_TASKS` can disable the policy. Engine/validation scratch is removed after each call, and successful launcher rebuilds release only the superseded untagged, unreferenced DevAgents image.

`npm run check` passed (248 tests passed, 3 skipped, backend/UI typechecks and build). Focused retention/launcher checks and the browser compaction-confirmation test also passed. The browser fixture route now matches only the API path rather than intercepting the HTML navigation. Live cleanup of nine completed tasks removed seven remaining clean worktrees, retained all nine reviewed result branches, and recovered about 12 GiB. No authenticated model calls were made. The selected policy now also removes clean completed task/item worktrees without force, retaining every branch and refusing local changes, unknown ignored files, hidden index flags or a changed reviewed result branch. The launcher rebuilt and restarted the service successfully. The running service reports automatic cleanup enabled; all nine completed result branches and diffs were verified, and no completed worktrees remain. After startup recovery and the rebuild, about 13.4 GiB is free. Isolated deterministic M2/M3 container smoke checks also passed, including sandbox validation and retained final commits; their temporary filesystem must exceed the unchanged 5 GiB admission threshold.

## Main-based task worktrees — 2026-11-03

New task worktrees resolve the current local main commit and create a fresh task branch, regardless of the registered checkout branch or local changes. Missing main fails explicitly; existing branches are never reset or reused. Original-checkout divergence checks and review evidence use a separately recorded HEAD, with backward compatibility for existing tasks. Worker dependency snapshots are preserved.

`npm run check` passed: 251 tests passed, 3 skipped, backend/UI typechecks and production build succeeded. Regression coverage includes dirty feature checkouts, exclusion of previous task results, a main update after registration, branch collisions, missing main without HEAD/origin fallback, and both single-item and DAG completion. No authenticated model calls were made. Deployed successfully after the launcher lock was released. The service is healthy; a disposable fixture inside the running container verified two distinct clean branches from local main while the source checkout stayed on a different dirty branch. All task counts were preserved, automatic cleanup remains enabled, and no model calls were made.

## Task usage visibility — 2026-11-03

- [x] Reported tokens per step/work item and attempt, with cached-input subsets and missing-usage counts.
- [x] Separate estimated API and API-equivalent costs, recorded pricing snapshots, unknown-model handling and explicit EUR conversion.
- [ ] Project/monthly usage rollups and budget enforcement (separate planned scope).
