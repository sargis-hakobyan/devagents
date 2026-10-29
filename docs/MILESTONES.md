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
- [x] Scoped shell/patch containment and two concurrent runtime fixtures under Compose CPU/memory/PID limits; Linux exact-file writes fail before inference.

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

- `npm run check`: 64 tests, typecheck and production build.
- `npm run test:m2`: deterministic planning/implementation/review with real sandboxed validation and a local commit.
- `npm run test:m3`: deterministic three-item DAG with isolated branches, dependency integration, actual sandboxed validation and a combined commit.
- `npm run test:m3-live`: opt-in authenticated three-item fixture; equivalent container command passed with saved ChatGPT sign-in. Native authenticated execution remains unverified.
- `npm run test:codex-protocol`: real pinned Codex shell/patch execution and structured events against a loopback model fixture; no account/API calls.
- `npm run test:docker`: isolated service persistence plus M2, M3 and protocol fixtures under Linux container restrictions.
- `npm run test:codex-live`: opt-in authenticated native fixture. The equivalent container command passed with ChatGPT sign-in; native authenticated execution remains unverified. See README.

M3 supports one active top-level request with bounded parallel work items, text changes and read-only Node/npm validation. Linux/Docker writes require directory-subtree grants; exact-file writes are rejected before model execution because of a pinned-runtime limitation. Scheduling uses deterministic waves, not immediate dispatch when a slot frees. Local inference, multiple engines, cross-request concurrency, generated build output policies and external actions remain later work.
