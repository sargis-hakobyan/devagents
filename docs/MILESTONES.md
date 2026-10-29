# Milestone checklist

## M0 — Compatibility (partially verified)

- [x] Current official Codex/Claude execution and authentication documentation.
- [x] Installed versions, native platform and Docker ARM64 startup.
- [x] Mastra suspension and storage/runtime recreation probe.
- [x] Native Codex filesystem sandbox probe with harmless sentinel files.
- [ ] Authenticated container login and real coding-engine fixtures.
- [ ] All runtime tool boundaries and network isolation verified in both environments.

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

## M2 — Single-engine vertical slice (next)

- [x] Worktree creation tested against dirty user checkout.
- [x] Dedicated Codex login command and setup diagnostics.
- [ ] Codex adapter: normalized streaming, timeout and child cancellation.
- [ ] Dynamic Tech Lead using registry and scoped project context.
- [ ] All runtime tools and validation commands enforce policy.
- [ ] Execute/test/independent review/bounded repair/local commit loop.
- [ ] Fake-engine end-to-end tests and opt-in real Codex fixture.
- [ ] Durable execution runs, evidence and worktree reconciliation metadata.

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

Before the M2 live fixture, configure the dedicated account with `npm run cli -- auth codex`, or use `auth codex --api-key-env OPENAI_API_KEY`. Login alone does not enable coding execution in M1.
