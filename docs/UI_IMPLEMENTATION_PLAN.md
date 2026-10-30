# Browser UI implementation plan (U1 first)

Status: plan for U1 to U3 as required by `docs/FRONTEND_IMPLEMENTATION_PROMPT.md`; U1 is being implemented against it. Visual reference: `design/ui/` (Direction A). Behaviour and acceptance: `docs/FRONTEND_BRIEF.md`.

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

- `GET /tasks?limit=&before=&projectId=&state=` cursor pagination by row id (default 50, max 200) returning summaries plus `nextBefore`.
- `GET /tasks/:id/events?after=&limit=` and `GET /tasks/:id/evidence?after=&limit=` with sequence cursors so polling appends without duplicates; evidence entries are truncated to 16 KB with `truncated: true`, and `GET /tasks/:id/evidence/:sequence` returns one entry bounded to 1 MiB.
- `GET /overview`: counts by state, attention items (awaiting mode, awaiting approval), the active task with its work items, recent outcomes. All values measured from the store.
- `GET /status`: runtime and credential availability without secrets (Codex installed/version, dedicated profile signed in, vault locked, Claude installed but not enabled), config defaults and limits, service info. Cached for 30 s because it runs `codex login status`.
- `GET /ui/session`, `POST /ui/bootstrap` (bearer only), `GET /ui/login`, `POST /ui/logout`.
- Existing routes keep their shapes for the CLI and scripts.

## Team persistence, migrations and task snapshots (U2, designed now)

- SQLite tables `teams` (id, name, description, archived, created/updated) and `team_revisions` (team id, revision, members JSON, created). Members are explicit copies of resolved templates (`AgentDefinition` plus `source: template|custom` and `templateId`). `projects` gains `defaultTeamId`. Tasks gain `team: {id, revision}` next to the existing `agents` snapshot; submission resolves the revision atomically and the runner uses the snapshot only. Legacy tasks without `team` read as "Legacy agent configuration". Schema version 3 migration adds the tables and columns; nothing rewrites YAML.
- Readiness diagnostics reuse `validatePlan`'s role checks (`selectImplementer`, `independentReviewer`) and the registry's capability allowlist.

## Test strategy

- **API/session:** bootstrap needs bearer; code single-use and expiring; cookie grants reads; replay rejected; wrong Host, foreign Origin, missing CSRF each 403; logout invalidates; bearer still rejects Origin; CSP header present; static shell public, data routes private.
- **Pagination/cursors:** list limits and cursors, events and evidence `after` cursors return only new rows, evidence truncation and single-entry fetch, overview counts match the store.
- **Browser (Playwright):** against the fixture service: login via link; overview shows measured counts; task list filters; task detail for completed, failed and awaiting-approval tasks; hostile request text with `<script>` and `<img onerror>` renders as text with no script execution; disconnect and reconnect show the banner and append events without duplication; narrow viewport renders. Screenshots are written to `docs/screenshots/`.
- **Existing suites:** `npm run check`, deterministic M2/M3, protocol smoke and the Docker suite (extended to assert `/ui/` is served and the bootstrap exchange works in the container).

## Out of scope for U1

Team editing (U2); submission, mode choice, approval, cancellation, registration, cleanup and guided setup from the browser (U3); event streaming; the Claude adapter (M4). The authenticated M2/M3 reruns remain pending and are not part of this work.
