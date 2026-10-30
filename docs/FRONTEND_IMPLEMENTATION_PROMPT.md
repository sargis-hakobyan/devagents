# Handoff to Claude — DevAgents browser UI

You are designing and implementing the local DevAgents browser interface. Use your available frontend design tools for the visual design; the product behaviour and boundaries below are already agreed with the owner. Make reasonable visual/toolchain choices and document them rather than asking the owner to select every detail.

## Read first

1. `DEV_AGENTS_SPEC.md` and `IMPLEMENTATION_PROMPT.md`.
2. `docs/FRONTEND_BRIEF.md` in full: this is the approved UI scope and acceptance contract.
3. `docs/MILESTONES.md`, `docs/DECISIONS.md`, `README.md`.
4. `CLAUDE_REVIEW.md` and `CLAUDE_REVIEW_FIXES.md`; preserve the original review.
5. Current domain schemas, registry, service/API, persistence and tests. Inspect Git status and preserve other work.

## What to build

Design the complete Overview, Teams, Projects, Tasks and Settings experience, including the team/member editor and task detail page. Produce a coherent visual language with clear hierarchy, readable activity, meaningful status and accessible controls. Prioritize a useful daily tool over decorative metrics. Include empty, loading, disconnected, failed and approval-required states alongside the successful example.

Then implement U1 first as a working vertical slice backed by real service data and a secure local browser session. Add U2 team management and U3 browser actions in separate reviewed increments, following the brief. Do not report an increment complete until its acceptance checks pass. Keep M4 separate; do not implement the second engine adapter as part of this work.

The API currently rejects browser origins, the registry is file-based, and saved teams do not yet exist. Treat these as explicit backend work. Do not fake team counts, process activity, progress percentages or model availability. Demonstration fixtures must be clearly labelled and restricted to development/test mode.

Before substantial UI code, write a short implementation plan covering the chosen frontend stack, routes/screens, browser session/CSRF design, API changes, team persistence and migrations, task snapshots, and test strategy. Work within the current architecture and preserve the CLI. Serve the built UI from the same application/image in production; no second user-managed frontend service.

## Rules that must survive the UI

- One active top-level request; bounded parallel work items. Saved teams are reusable configurations, not always-running processes.
- Plan approval and independent review are backend-enforced. No permissions, model access or missing capabilities inferred merely from a role name.
- Team changes apply only to future submissions. Freeze the selected revision and resolved instructions/settings for queued and active tasks.
- Preserve YAML/Markdown configuration and old tasks. Browser-managed teams must not silently rewrite built-in or repository agent files.
- Existing repositories only, explicit Docker mounts, isolated managed worktrees and no changes to the original checkout.
- Keep credentials on the backend. Preserve the vault/keychain flow; do not disable origin protections or expose the permanent CLI bearer token to make the browser work.
- Model text, logs and diffs are untrusted. Escape/sanitize rendering, bound payloads and protect state-changing routes against CSRF.
- No automatic paid connection tests, live model calls, push, merge, deployment, or destructive cleanup.

## Verification and delivery

Use deterministic engine fixtures for browser workflows. Add focused security/API/domain regression tests for session handling, teams/snapshots and actions as they are implemented. Run the existing check and relevant deterministic/protocol/Docker suites for affected components. Visually inspect representative desktop and narrow-screen states and record screenshots and known limitations.

Authenticated M2/M3 post-review reruns remain pending. Design and deterministic UI work can proceed, but this task does not authorize live tests or claim release acceptance. Record the pending gate accurately; M4 remains deferred until acceptance is established.

Keep README, milestone checklist and decision log current. Commit coherent increments separately. Do not push. Finish each increment with what works, tests actually run, screenshots, known limitations and the exact next step. Keep unimplemented controls visibly unavailable rather than presenting success messages for mock actions.
