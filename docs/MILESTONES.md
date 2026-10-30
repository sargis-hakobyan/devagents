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

- [ ] Re-run authenticated M2 and M3 fixtures against the post-review baseline, only when explicitly authorized. Historical live passes above predate the review fixes; the final follow-up record reports 99 tests and deterministic/protocol/Docker suites passing, but not these live reruns.

## U1–U3 — Local browser UI (approved 2026-10-30; not implemented)

Design and implementation owner: Claude, using its frontend design tools. Product scope and acceptance are in [the frontend brief](FRONTEND_BRIEF.md); start with [the implementation handoff](FRONTEND_IMPLEMENTATION_PROMPT.md). Design and deterministic UI development may proceed while the live gate is pending; do not declare release acceptance or start M4 until it is satisfied.

- [x] Product brief, implementation handoff and roadmap alignment.
- [x] Full screen/state design: Overview, Teams, Projects, Tasks and Settings. Two directions were designed; Direction A was chosen with its Overview restructured for density. Source boards live in `design/ui/` (see its README).
- [x] U1: same-origin app shell, protected browser session, real read-only progress/history/results, safe content rendering and browser/CLI compatibility. Verified natively with 9 Playwright workflows against the labelled fixture (sign-in, overview, list, completed/approval/failed/cancelled/mode-wait detail, hostile content, disconnect and reconnect, narrow screen, sign-out) plus API/session regression tests; Docker smoke covers the in-image UI and bootstrap exchange.
- [x] U1 status review fixes: category-first overview queries, state filters before pagination, history-derived plan approval, and bounded structured facts alongside evidence previews. Three new API tests and four new browser regressions; see [verification record](U1_REVIEW_FIXES.md).
- [ ] U2: persisted reusable teams, custom/template members, revisions, readiness, archive/duplicate, project defaults, submission snapshots and legacy compatibility.
- [ ] U3: guided setup, project registration, task submission/mode, version-bound plan approval, cancellation and safe diff inspection.
- [x] U1 browser workflow/security tests, responsive layout, screenshots in `docs/screenshots/` and native/Docker packaging. Repeat for U2 and U3.
- [ ] U2/U3 as above.

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

## Acceptance commands

- `npm run check`: 107 tests, backend and UI typecheck, production build of service and UI (one real-sandbox containment test runs only when the pinned Codex is installed).
- `npm run test:m2`: deterministic planning/implementation/review with real sandboxed validation and a local commit.
- `npm run test:m3`: deterministic three-item DAG with isolated branches, dependency integration, actual sandboxed validation and a combined commit.
- `npm run test:m3-live`: opt-in authenticated three-item fixture; equivalent container command passed with saved ChatGPT sign-in. Native authenticated execution remains unverified.
- `npm run test:codex-protocol`: real pinned Codex shell/patch execution and structured events against a loopback model fixture; no account/API calls.
- `npm run test:docker`: isolated service persistence plus M2, M3 and protocol fixtures under Linux container restrictions.
- `npm run test:codex-live`: opt-in authenticated native fixture. The equivalent container command passed with ChatGPT sign-in; native authenticated execution remains unverified. See README.

M3 supports one active top-level request with bounded parallel work items, text changes and read-only Node/npm validation. Linux/Docker writes require directory-subtree grants; exact-file writes are rejected when the plan is validated, before approval, and again before model execution because of a pinned-runtime limitation. Scheduling uses deterministic waves, not immediate dispatch when a slot frees. Local inference, multiple engines, cross-request concurrency, generated build output policies and external actions remain later work.
