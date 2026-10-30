# DevAgents browser UI — product and implementation brief

Status: approved direction; U1 implemented, U2/U3 planned. Owner approval: 2026-10-30. Claude owns frontend design and implementation using its design tools. This brief defines behaviour and acceptance; visual details are deliberately left to the designer.

Read this with `DEV_AGENTS_SPEC.md`, `IMPLEMENTATION_PROMPT.md`, `docs/MILESTONES.md`, and `docs/UI_IMPLEMENTATION_PLAN.md`. This decision brings a focused local dashboard into scope; it does not authorize M4 engine work, remote hosting, or live model tests.

## Product purpose

A user starts DevAgents, opens a browser, and understands:

1. Which teams and projects they have.
2. What is running, queued, completed, or blocked.
3. What needs their attention and what action will resolve it.

The browser becomes the everyday interface. The CLI remains supported for setup, automation, diagnostics, and environments without a browser. This is a single-user local application, not a hosted collaboration service.

## Information architecture

| Navigation | Primary content | Primary actions |
| --- | --- | --- |
| Overview | Active team count, running/queued task counts, approvals, connection state, recent outcomes | Open a task, resolve an attention item, create a task |
| Teams | Named reusable teams, descriptions, member counts, readiness, active/archive filters | Create, duplicate, edit, archive |
| Projects | Registered repositories, default team, recent tasks, path/access diagnostics | Register an existing repository, set default team, open history |
| Tasks | Filterable task summaries by project, team and state | Submit work, inspect a task |
| Settings | Connection availability, engine/model defaults, execution limits | Use supported setup flow, edit validated settings |

Use a persistent desktop sidebar, clear page titles and one obvious primary action per page. Prioritize readability and useful density over decoration. Use consistent status text plus icons; colour alone must not convey meaning. Narrow screens must still support reading progress and approving plans; do not build a separate mobile client.

## Teams and members

A team is a saved, named roster reusable across projects. Examples: Website Team and Backend Team. A project may choose a default team; a new task can select another. Multiple saved teams do not imply multiple top-level tasks can execute concurrently.

Suggested initial template: Tech Lead, Developer, QA Engineer, Code Reviewer. Templates may also include backend/frontend specialists. Keep the existing flat delegation model and independent-review requirements. Creating a member does not start a background process or invoke a model.

The member form supports:

- Name and role description in plain language.
- Detailed instructions, with a useful starting template.
- Engine, provider and model, defaulting to inherited values and explaining their resolved values.
- Enabled/disabled state.
- An advanced section for supported capabilities, read/write scope, command permission and concurrency.

Allow **Add member → From template / Custom**. A user can name a custom member Graphic Designer, but the UI must state which capabilities actually exist; it must not imply that image generation, local inference, or Claude execution is available before those integrations work. Configuration schemas accepting an engine ID are not proof of runtime support. Unsupported choices should be visibly unavailable with a reason.

Team validity and readiness are distinct: an incomplete team may be saved as a draft with actionable diagnostics, but cannot run work until planner, implementer and independent-review requirements are satisfied. Validate again on submission and plan generation. Do not force every template role to participate in every task; the Tech Lead selects the appropriate available members.

Archive teams rather than deleting historical references. Existing tasks remain readable, active tasks keep their snapshots, and archived teams cannot receive new submissions. Editing a team affects future submissions only. Duplication creates independent member configurations, not hidden shared mutable instances.

## Task submission and execution

Submit a request with project, team, acceptance criteria and autonomy mode. Respect an explicit task mode and existing project defaults. When no mode is resolved, show the existing blocking choice; do not silently default to autonomous execution. Display a resolved summary before submission.

The task detail screen is the main working screen:

- Header: request/title, project, team revision, state, elapsed time and the currently permitted action.
- Summary: plain-language current activity and any reason the task is waiting.
- Work: item cards with assigned agent, dependencies, stage, validation/review result and repair attempt. Offer a dependency graph as a secondary view; the list must remain sufficient and accessible.
- Plan: deliverables, scope, risks, validation commands and acceptance criteria. Plan approval binds to the exact task version; a stale approval must refresh rather than approve changed work.
- Activity: chronological persisted events with timestamps and actor. Detailed evidence is expandable, bounded and paginated.
- Result: summary, changed files, read-only diff, tests, review outcome, branch and commit. Completion means a local reviewed commit, not a merge or deployment.

Stages may revisit tests, review and implementation during repair. Do not depict a repair loop as a permanently completed linear step. Show measured item counts and real stages, not invented completion percentages or completion-time estimates. Connection state and model-access verification are separate: saved credentials do not establish quota or access to every model.

Explain queued work: the current scheduler permits one active top-level request with bounded parallel items inside it. A member badge such as “Working” must derive from actual activity; “Available” means enabled and eligible, not an always-running agent process.

Required states include empty workspace, no teams, missing project, missing/locked connection, unverified model access, queued, awaiting mode, planning, awaiting approval, running, validating, reviewing, repairing, committing, completed, failed, cancelled, interrupted history, service disconnected and reconnecting. Distinguish user cancellation, shutdown interruption and sibling aborts. Offer cancellation only where the backend permits it; committing remains non-cancellable. Do not offer pause/resume or automatic retry unless the backend gains and tests that contract. A later resubmission must create a new task and make the relationship clear.

## Onboarding and connections

Target journey: start DevAgents → open browser → reuse or set up a connection → register an existing project → select/create a team → submit work.

Preserve the existing encrypted credential vault, OS keychain master-key handling, and supported runtime login flows. Initial UI iterations can guide users through the existing terminal setup; label this honestly. Browser authentication is separate from model-provider authentication. Browser opening must be optional and degrade to printing the local URL for headless hosts.

Project registration takes an existing absolute repository path. In Docker it must already be explicitly mounted, and the service sees its container path. Explain the host/container distinction, validate access and provide copyable setup instructions. A browser folder picker does not grant arbitrary host filesystem access. Do not mount home directories or the Docker socket, or add a generic filesystem browser.

Do not trigger paid connection tests automatically. If offered later, make their scope and allowance use clear and require the user's explicit choice. Do not put credentials into task prompts, URLs, analytics, frontend persistent storage, or repository files. Never display an existing saved secret; a replacement is write-only.

## Data and backend integration

Current source of truth:

- `src/domain/schemas.ts`: agents, projects, tasks, plans and lifecycle types. There is no Team entity yet.
- `src/agents/registry.ts`: YAML/Markdown resolution in built-in → user → project precedence. Browser editing does not exist yet.
- `src/api/server.ts`: bearer-authenticated projects, agents, task summaries/details, events, evidence, items, approvals, cancellation and cleanup. Browser-origin requests are currently rejected.
- `src/persistence/store.ts`: SQLite task state and append-only history; tasks already hold resolved agent snapshots.

Add first-class teams in the team-management increment. Use SQLite for team/member drafts, revisions, project defaults and task-to-team references. Use existing domain schemas and validators; keep YAML/Markdown usable as templates and the legacy CLI/API path. A UI-managed team stores its own explicit member definitions, copied from resolved templates when added. Do not silently overwrite built-in files or project overrides from the browser. Refreshing a member from a changed template is an explicit, reviewable action for future runs.

At submission, atomically resolve and freeze the selected team revision and all execution-relevant member configuration, including instructions and resolved engine/provider/model defaults. Queued work must not pick up subsequent edits. Store team identity and revision alongside the existing task snapshot. Plan validation and execution use that snapshot. Legacy tasks without a team remain readable as “Legacy agent configuration”; legacy submissions without a selected/default team retain their current registry behaviour. Do not count legacy configuration as an invented saved team.

Keep orchestration and policy in the backend; the browser must not implement a second scheduler or bypass validation. Share typed contracts without bundling server modules or secrets. Add validated team/member CRUD, optimistic revision checks, project-default updates, bounded task detail/diff retrieval and safe setup status only as each increment needs them. Existing list endpoints need bounded pagination/filtering as history grows; full evidence is not a list payload. Resolve diff requests from server-owned task/commit identities, never arbitrary client-supplied filesystem paths or shell arguments.

Prefer a same-origin frontend bundled with the existing service and Docker image, using the existing port. The user should not run a separate frontend server in production. Claude may choose the frontend toolchain during implementation and record it, keeping the TypeScript backend independent. A separate development server is acceptable with an explicit local development setup.

Start progress updates with bounded polling and reconnect backoff. Add event streaming only when justified, with persisted cursors, reconnect recovery and ordering/deduplication. Never invent activity when disconnected; show the last update time and reconcile from server state.

## Browser security contract

Enabling the UI is a backend security change, not simply removing the Origin check or turning on wildcard CORS.

- Keep loopback binding by default and validate permitted Host and Origin values, including localhost/DNS-rebinding cases. Serve production assets and API on the same origin.
- Establish a local browser session through an explicitly designed, short-lived, single-use bootstrap initiated by the local launcher/CLI. Never expose the long-lived CLI bearer token to frontend code or localStorage. Specify expiry, exchange, restart and logout semantics and test replay rejection. Document cookie settings appropriate to the local HTTP/HTTPS deployment.
- Use an HttpOnly session cookie with suitable SameSite settings and CSRF protection for state-changing requests. Enforce authentication and authorization server-side on all data routes; preserve the CLI bearer path. Deny unexpected cross-origin access rather than trusting all localhost ports.
- Treat model text, logs, repository content, Markdown and diffs as untrusted data. Escape by default; disable raw HTML or sanitize it rigorously. Do not load remote images or execute links/scripts from generated content automatically. Apply an appropriate content-security policy.
- Keep connection diagnostics secret-free. Preserve existing redaction, protected paths, permission checks and independent-review gates. Render unavailable data honestly; do not show fabricated pricing or allowance balances.
- Cleanup is a separate explicit action with a preview of affected managed worktrees/branches and retained deliverables. Never tie cleanup to simply viewing, archiving or hiding a task.

## Delivery sequence and acceptance

The authorized post-review authenticated M2/M3 reruns passed on 2026-10-30 at `db95711`; see `MILESTONES.md` for the commands, environment and scope. U2 is the next increment, with Claude owning frontend implementation. U3 and M4 remain separately reviewed work. Future authenticated model calls require explicit authorization; this frontend brief does not supply it.

### U1 — Visibility (first integrated UI increment, before M4)

Deliver the application shell, secure browser session, overview, read-only project/agent/task views, task details, measured progress, evidence and outcomes. Team navigation must honestly explain that saved team management arrives in U2; show the existing agent configuration without claiming it is persisted teams. Demo data belongs only in explicitly labelled development/design fixtures, never the production dashboard.

Acceptance: launch the local UI in native and Docker modes; preserve bearer CLI access; view a deterministic task through planning, implementation, validation, review and completion; refresh/reconnect without losing or duplicating history; render failure/empty/approval-wait states; reject unauthorized and hostile-origin requests; safely render hostile task content. No model credentials required for browser tests.

### U2 — Teams and member management

Deliver persisted teams, templates, custom members, duplicate/archive, revisioned editing, readiness diagnostics, project defaults and frozen task snapshots. Keep legacy registry and task compatibility.

Acceptance: create two teams, add a custom named member with instructions, edit and duplicate safely, reject invalid capabilities/permissions, prevent lost updates, archive without losing history, retain data over restart, and prove edits cannot change queued or active tasks. Prove a selected team actually constrains planner/worker membership rather than serving only as a visual label.

### U3 — Browser task workflow and guided setup

Deliver project registration, task submission, mode selection, version-bound plan approval, cancellation, bounded read-only diffs and guided connection setup. Reuse the existing secure terminal flow where browser integration has not been demonstrated; do not claim a fully browser-based credential wizard prematurely. Add explicit cleanup only after its preview and ownership guarantees are tested.

Acceptance: with a deterministic engine, a user registers a fixture project, selects a team, submits a task, approves its plan and sees actual tests/review and a local commit without manipulating API tokens. Verify duplicate-click idempotency, stale approval, rejected plans, cancellation, disconnect/restart, missing connection and invalid Docker path handling. Original checkout remains unchanged.

Each increment needs accessible keyboard navigation, visible focus, labelled fields, useful validation messages, loading/empty/error states, responsive layouts, and browser-level tests for its real workflows. Record screenshots of representative states for visual review and test API/domain changes with the existing suites. Do not replace the backend to make a mockup appear functional.

M4 remains a separate engine-portability milestone. All UI model controls must leave room for its engine registry, but adding the Claude adapter, hosted accounts, nested teams, cross-task concurrency, local inference, GitHub actions and image generation is outside this brief.
