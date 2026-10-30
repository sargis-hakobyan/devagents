# Browser UI implementation plan (U1 first)

Status: U1 implemented; U2/U3 planned as required by `IMPLEMENTATION_PROMPT.md`. Visual reference: `design/ui/` (Direction A). Behaviour and acceptance: `docs/FRONTEND_BRIEF.md`.

## Stack

- **Frontend:** Vite + Preact + TypeScript under `ui/`, built to `ui/dist` and copied into `dist/ui` by `npm run build`. Preact escapes text by default, is small, and needs no runtime beyond the bundle. Routing with `preact-iso` (history routing under `/ui/`). No UI component library, no CSS framework: one hand-written stylesheet with the tokens from `design/ui/README.md`. No remote fonts or scripts; a system font stack stands in for the design's Plus Jakarta Sans.
- **Backend:** unchanged Node/TypeScript service. The built UI is served by the existing HTTP server on the existing port, same origin as the API, in native and Docker modes. No second user-managed frontend service; the Vite dev server is a developer convenience only (`npm run dev:ui`, proxying API calls to a running service).
- **Tests:** Node test runner for API, session and domain tests (`npm test`, no browser needed). Playwright for browser workflow tests (`npm run test:ui`) against a clearly labelled development fixture service with the deterministic fake engine; requires a one-time `npx playwright install chromium`.

## Routes and screens

| URL | Screen | U1 scope |
| --- | --- | --- |
| `/` | redirect to `/ui/` | yes |
| `/ui/login?code=…` | exchanges a one-time bootstrap code for a session cookie, then redirects to `/ui/` | yes |
| `/ui/` | Overview: attention items, running task with items, recent outcomes, counts, connection, scheduler | yes, read-only |
| `/ui/tasks` | Task summaries with state/project filters and cursor pagination | yes, read-only |
| `/ui/tasks/:id` | Task detail: header, summary, work items, plan, activity (cursor-paged), result | yes, read-only |
| `/ui/teams` | Current agent configuration from the registry, labelled honestly; saved teams arrive in U2 | yes, read-only |
| `/ui/projects` | Registered repositories with diagnostics and registration instructions | yes, read-only |
| `/ui/settings` | Connection availability (secret-free), engine/model defaults, limits, service and session info | yes, read-only |
| `/ui/signed-out` | After logout or an expired session, with the command that mints a new link | yes |

Action controls that arrive in U2/U3 (submit, approve, cancel, register, team editing, cleanup) are rendered disabled with the reason and the CLI alternative.

## Browser session and CSRF

- **Bootstrap:** `devagents ui [--open]` (CLI, bearer-authenticated) calls `POST /ui/bootstrap`, which mints a single-use code (32 random bytes, 10-minute expiry, consumed on first use) and prints `http://127.0.0.1:<port>/ui/login?code=…`. `--open` tries the OS opener; otherwise the URL is printed, which is the headless path. `serve` never prints codes; the long-lived CLI bearer token never reaches the browser.
- **Exchange:** `GET /ui/login?code=…` validates and consumes the code and sets `devagents_session` as an `HttpOnly; SameSite=Strict; Path=/` cookie (no `Secure` on plain local HTTP; set when `DEVAGENTS_HTTPS=1` later). Sessions live in memory: 12 h idle expiry, 24 h absolute; a service restart ends every session and the user mints a new link. Replay of a consumed code is rejected with 403.
- **CSRF:** every session has a CSRF token. `GET /ui/session` returns `{authenticated, csrfToken, expiresAt}` for same-origin requests. State-changing routes authenticated by cookie require `X-CSRF-Token` equal to the session's token; a bad or missing token is 403. `POST /ui/logout` destroys the session.
- **Host and Origin:** cookie-authenticated requests must carry a `Host` in the loopback allowlist for the configured port (`127.0.0.1`, `localhost`, `[::1]`) and, when `Origin` or `Sec-Fetch-Site` is present, it must be same-origin. Anything else is 403, even from another localhost port. Bearer requests keep today's rule: any `Origin` header is rejected, so the CLI path is unchanged.
- **Static assets and CSP:** `/ui/` and `/ui/assets/*` are served from the built bundle with `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`. The shell HTML is public; every data route requires a session or bearer.
- **Untrusted content:** task requests, plans, evidence, diffs and agent instructions are rendered as text nodes only. No Markdown rendering in U1, no raw HTML, no links or images generated from content. Evidence entries are bounded server-side.

## API changes (U1)

- `GET /tasks?limit=&before=&projectId=&state=` cursor pagination by row id (default 50, max 200); repeated state parameters are ORed before pagination. Returns summaries, `nextBefore`, and project-wide state counts independent of the current page/state filter.
- `GET /tasks/:id/events?after=&limit=` and `GET /tasks/:id/evidence?after=&limit=` with sequence cursors so polling appends without duplicates; evidence text is previewed at 16 KB with `truncated: true` and a separately bounded metadata projection retaining execution facts, and `GET /tasks/:id/evidence/:sequence` returns one entry bounded to 1 MiB.
- `GET /overview`: counts by state, attention items (awaiting mode, awaiting approval), the active task with its work items, recent outcomes. Each category is queried independently before limiting; execution is also separated from queued work so old running tasks cannot disappear behind new submissions. Attention previews link to the full filtered list. All counts cover the store, not a recent-history slice.
- `GET /status`: runtime and credential availability without secrets (Codex installed/version, dedicated profile signed in, vault locked, Claude installed but not enabled), config defaults and limits, service info. Cached for 30 s because it runs `codex login status`.
- `GET /ui/session`, `POST /ui/bootstrap` (bearer only), `GET /ui/login`, `POST /ui/logout`.
- Task detail adds history-derived `approval` status/timestamp; current state alone never implies user approval. Read-only response additions preserve existing fields for the CLI and scripts.

## Team persistence, migrations and task snapshots (U2, designed now)

- SQLite tables `teams` (id, name, description, archived, created/updated) and `team_revisions` (team id, revision, members JSON, created). Members are explicit copies of resolved templates (`AgentDefinition` plus `source: template|custom` and `templateId`). `projects` gains `defaultTeamId`. Tasks gain `team: {id, revision}` next to the existing `agents` snapshot; submission resolves the revision atomically and the runner uses the snapshot only. Legacy tasks without `team` read as "Legacy agent configuration". Schema version 3 migration adds the tables and columns; nothing rewrites YAML.
- Readiness diagnostics reuse `validatePlan`'s role checks (`selectImplementer`, `independentReviewer`) and the registry's capability allowlist.

### U2 implementation handoff to Claude

Owner confirmed on 2026-10-30: Claude implements the frontend and its required backend contracts. Work directly on local `main`, in separately reviewable commits. Do not push without a new explicit command from the owner. U2 is the next implementation increment; U3 and M4 remain separate. Use `A-Teams.dc.html` and the selected Direction A styles, with the behaviour in `FRONTEND_BRIEF.md` taking precedence over illustrative board text.

Implement in this order:

1. **Persistence and domain contracts.** Add a transactional schema-3 migration, versioned team records and immutable member revisions. Store project defaults and task team references durably. Preserve existing projects, tasks, events, evidence and idempotency records; do not manufacture saved teams from legacy registry entries. Define strict schemas with bounded roster size and instruction lengths that fit the API request limit. Reuse the supported capability, delegation, path and permission rules. Incomplete role coverage can be saved as a draft; malformed or forbidden permissions must be rejected. Compute readiness on the server, with actionable per-member diagnostics, independently of saved-login or model-access status.
2. **Service/API and submission integration.** Add team list/detail/create/edit/duplicate/archive and project-default updates behind the existing authentication and CSRF checks. Require an expected revision for edits and archive, and an equivalent concurrency check for project-default changes; return a conflict instead of overwriting another edit. Add CLI/API task team selection now so U2 execution can be exercised without introducing the U3 browser submission flow. Specify explicit team, project default and legacy fallback precedence. An archived default must produce an actionable error on a new submission, not silently fall back to the registry.
3. **Immutable execution configuration.** Resolve a selected team and persist its identity, revision, display name and execution settings atomically with task creation. Check an existing idempotency key before resolving newer mutable defaults: retrying the same submission after a team edit/archive must return the original task. Freeze instructions, permissions, delegation, concurrency and resolved engine/provider/model choices even when mode selection or a queue delays execution. Preserve the existing legacy path when no team is selected or defaulted. Both single-item and DAG execution, including planning, integration and review, must use the selected roster without adding registry members.
4. **Browser management.** Replace the Teams placeholder with saved-team counts/list, active/archive filters, create/edit/duplicate/archive, template/custom member forms, enabled state, advanced permissions and server readiness diagnostics. Copy template definitions explicitly; never silently sync later template changes or write browser edits into YAML files. Include loading, empty, saving, conflict and failure states, labelled fields, keyboard focus and narrow-screen layouts. Disable unavailable engines/providers/capabilities with reasons. Project cards can set/clear a default team. Update overview and task labels to show real saved teams/revisions while retaining “Legacy agent configuration” for old tasks. Keep U3 actions disabled.
5. **Acceptance and record.** Add the regression coverage below, run the relevant deterministic suites, inspect browser screenshots, update README/milestones/decisions and commit locally. Report exactly what ran, any limits and the remaining U3 work. Do not run authenticated model tests merely because the implementation is finished; future live calls require separate authorization.

Code integration points that need particular care:

- `TaskService.submit()` currently resolves mode and calls `Store.createTask()` synchronously. Move team resolution into the task-creation transaction or an equally atomic store operation; attaching a team later via a checkpoint leaves a race. Preserve duplicate-request behaviour and the single-active-request scheduler.
- `TaskRunner` already prefers `task.agents`, but legacy agents are first snapshotted at worktree creation. Its `provider()` still resolves service defaults on each call. Team tasks must not re-resolve mutable defaults during planning, preflight, implementation, integration or review. Store non-secret provider configuration where needed; never store credential values with task snapshots.
- There is currently no configured default model ID: `model: default` tells the Codex CLI to choose at execution. Merely copying that string does **not** pin a resolved model. Implement and document a supported resolution strategy before claiming U2 snapshot acceptance. If an exact model cannot be resolved, expose that limitation and require an explicit configured model for a fully pinned team submission; do not guess a model ID or trigger an automatic paid discovery call. Preserve legacy runtime-default behaviour.
- `Agent` configuration accepts `claude-code` and provider definitions that are not executable yet. Readiness must use actual runtime support as well as schema validity. Keep the per-agent engine registry/second adapter in M4.
- Reuse `selectImplementer`, `independentReviewer`, ownership checks and plan validation; a roster-level readiness check cannot guarantee that every future plan or project scope is valid. Plan validation remains a separate gate.
- Use bounded team summaries for lists, fetching member instructions only for detail/edit. Extend the Vite proxy for new API routes if used in development. Keep cookie, Host, Origin and CSRF enforcement intact.
- `TaskDetail.tsx` currently describes an existing legacy agent snapshot as taken “at submission”, although the legacy runner snapshots at worktree creation. Correct that wording when introducing genuine submission-time team snapshots; do not invent historical timing for legacy tasks.

Required U2 regression coverage:

- Upgrade a schema-2 database containing project/task/history records, then reopen it and verify both old records and new teams survive.
- Create two independent teams, add a custom named member with instructions, edit, duplicate and archive. Reject unsupported capabilities and forbidden/traversing permission grants; save incomplete role coverage as a draft and block its submission.
- Exercise stale edits/archive/default updates from two clients; the later stale write must fail without losing the first write or replacing unsaved browser input silently.
- Submit behind a blocked active task, edit/archive the selected team and change service defaults, then release the queue. Verify the queued task uses the original roster, instructions, permissions and concrete execution choices. Repeat for an awaiting-mode task, a running task and restart recovery.
- Verify idempotent retries after edits/archive return the original task, while a genuinely different submission with the same key conflicts. Archived-team submissions fail; existing task history remains readable.
- Use a deterministic engine to prove a selected team constrains the planner, worker and reviewer pool; an assignment to an excluded registry agent must fail before execution. Include DAG integration/review coverage and unchanged legacy submissions.
- Browser workflows cover create/edit/custom/template/duplicate/archive/default selection, actionable readiness, stale-save recovery, hostile text escaping and responsive keyboard use. Test new mutations with missing CSRF and foreign origins. Store screenshots only in the existing ignored output directory.

## Test strategy

- **API/session:** bootstrap needs bearer; code single-use and expiring; cookie grants reads; replay rejected; wrong Host, foreign Origin, missing CSRF each 403; logout invalidates; bearer still rejects Origin; CSP header present; static shell public, data routes private.
- **Pagination/cursors:** list limits and cursors, events and evidence `after` cursors return only new rows, evidence truncation and single-entry fetch, overview counts match the store.
- **Browser (Playwright):** against the fixture service: login via link; overview shows measured counts; task list filters; task detail for completed, failed and awaiting-approval tasks; hostile request text with `<script>` and `<img onerror>` renders as text with no script execution; disconnect and reconnect show the banner and append events without duplication; narrow viewport renders. Screenshots are generated in ignored `test-results/ui-screenshots/` by default; override with `DEVAGENTS_UI_SCREENSHOT_DIR` when needed. They are not source artifacts or visual assertion baselines.
- **Existing suites:** `npm run check`, deterministic M2/M3, protocol smoke and the Docker suite (extended to assert `/ui/` is served and the bootstrap exchange works in the container).

## Out of scope for U1

Team editing (U2); submission, mode choice, approval, cancellation, registration, cleanup and guided setup from the browser (U3); event streaming; the Claude adapter (M4). The separately authorized authenticated M2/M3 reruns passed on 2026-10-30 at `db95711`; see `MILESTONES.md`. This implementation plan does not authorize additional model calls.
