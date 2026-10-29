# Milestone checklist

## M0 — Compatibility (partially verified)

- [x] Current official Codex/Claude execution and authentication documentation.
- [x] Installed versions, native platform and Docker ARM64 startup.
- [x] Mastra suspension and storage/runtime recreation probe.
- [x] Native Codex filesystem sandbox probe with harmless sentinel files.
- [x] Dedicated container API-key authentication recognized by Codex.
- [ ] Real coding-engine fixture: first live request blocked by API quota.
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

## M2 — Single-engine vertical slice (implemented; live acceptance pending)

- [x] Worktree creation tested against dirty user checkout.
- [x] Dedicated Codex login command and setup diagnostics.
- [x] One-command Docker startup with hidden first-run API-key prompt and persistent reuse.
- [x] Codex adapter: normalized streaming, timeout and child cancellation.
- [x] Dynamic Tech Lead using registry and scoped project context.
- [x] Pinned runtime shell/patch and validation containment tested; unsupported tools disabled.
- [x] Execute/test/independent review/bounded repair/local commit loop.
- [x] Fake-engine end-to-end tests and opt-in real Codex fixture command.
- [ ] Authenticated real model fixture passes; attempted 2026-10-29, blocked by API quota before planning.
- [x] Durable execution runs, evidence and worktree reconciliation metadata.

## Later

- [ ] M3: DAG scheduler, parallel worktrees, integration/conflicts.
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

- `npm run check`: 30 tests, typecheck and production build.
- `npm run test:m2`: deterministic planning/implementation/review with real sandboxed validation and a local commit.
- `npm run test:codex-protocol`: real pinned Codex shell/patch execution and structured events against a loopback model fixture; no account/API calls.
- `npm run test:docker`: isolated service persistence plus M2 and protocol fixtures under Linux container restrictions.
- `npm run test:codex-live`: opt-in authenticated native fixture, still pending. See README for the equivalent container command.

M2 deliberately supports one work item, serial execution, text changes, exact/subtree path grants and read-only Node/npm validation. Local inference, multiple engines, parallel scheduling, generated build output policies and external actions remain later work.
