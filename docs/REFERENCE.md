# DevAgents technical reference

For current first-run instructions, see [Setup](SETUP.md). This guide retains the detailed execution, security, configuration and development reference.

DevAgents is an open-source, local-first AI development-team orchestrator, being built to plan, delegate, implement, test and review changes with configurable agents and replaceable coding engines.

**Current status: M3 multi-agent execution implemented and live container acceptance verified with ChatGPT sign-in.** A dynamic Tech Lead plans a task DAG and selects configured specialists. Independent items run in isolated worktrees with bounded concurrency; dependency results are integrated before downstream work starts. Real sandboxed checks and independent item/combined review gate the final local commit. Approval waits, bounded repairs, cancellation and execution evidence are persisted. Native and Docker checks are documented in [milestones](MILESTONES.md), [compatibility findings](M0_FINDINGS.md), and [decisions](DECISIONS.md).

The local **browser UI includes U1 visibility, U2 saved teams and U3 browser workflows**. The service serves a same-origin dashboard with protected browser sessions, project registration, task submission, mode choice, version-bound approval, cancellation, measured progress, completed-task diffs and browser/terminal setup. Saved teams have a member editor, immutable revisions, readiness diagnostics and project defaults. See [Browser UI](#browser-ui), the [frontend brief](FRONTEND_BRIEF.md), the [implementation plan](UI_IMPLEMENTATION_PLAN.md) and [design boards](../design/ui/README.md). The separately authorized M2/M3 live reruns passed on 2026-10-30 at `db95711`; U3 verification uses deterministic fixtures only.

## Docker quickstart

```sh
./devagents start
```

The launcher builds on first use or source changes, starts the service in Docker, unlocks encrypted credentials, then offers **Browser**, **Terminal**, or **Later**. Browser setup connects Codex through device sign-in or an API key; terminal setup offers the same authentication methods. Saved connections are reused on later starts. Run `./devagents project add` to mount and register a checkout without editing YAML. ChatGPT sign-in uses your plan’s Codex allowance; API keys use separate API billing. Keys are entered at a password field or hidden terminal prompt. For ChatGPT, the wizard explains device-code enablement and the official runtime provides the login link and one-time code. No host Node.js is required. The initial build downloads dependencies and Codex. The API is at `127.0.0.1:4310`; `/health` reports readiness. The `devagents-data` volume persists state. Home directories and the Docker socket are not mounted.

For the optional manual mount route, copy `examples/compose.project.yaml` to `compose.override.yaml`, set the absolute source path, then:

```sh
./devagents start
docker compose exec devagents node dist/cli/main.js projects add "My project" /projects/my-project
```

Registration takes the **container path**. On Linux, the container's non-root UID 1000 needs access to the mount; configure ownership/ACLs rather than running as root. Native/container Git worktree paths are not interchangeable. Keep managed worktrees separate between environments. Dirty changes remain in the original checkout and are not copied into task worktrees.

You can select a method directly:

```sh
./devagents start --auth chatgpt        # Guided ChatGPT device login
./devagents start --auth api-key        # Hidden API-key prompt (also replaces a saved key)
./devagents start --auth saved          # Reuse without the method menu
./devagents start --replace-key         # Compatibility alias for --auth api-key
```

After sign-in, setup offers a small **optional connection test**, skipped by default. It sends a fixed prompt to the default Codex model from an empty temporary directory with no project access or command permission. It consumes the selected plan’s allowance or API credits. A saved login is not reported as verified model access until this request succeeds. Results explain authentication, quota, rate-limit, connectivity, and runtime problems without printing raw provider errors. It does not test every configured agent/model or replace a full workflow fixture.

```sh
./devagents start --auth saved --test-connection
```

Noninteractive default starts print a browser setup link without making an authentication or model request. Explicit terminal setup reuses saved credentials, or reports that interactive sign-in is required. A failed connection check exits nonzero while keeping the service and saved credentials available. No automatic switch between billing methods occurs. Ctrl+C cancels setup or the running connection test.

Credentials are encrypted with AES-256-GCM in `/data/credentials/codex.enc` inside the persistent Docker volume. The separate random encryption key lives in **macOS Keychain** (or a Linux desktop Secret Service via `secret-tool`). The launcher retrieves it automatically; a locked OS keychain may require your normal OS unlock. No encryption key is stored beside the encrypted file.

Codex’s decrypted credential file and the encryption key exist only in the container’s private `/run/devagents-auth` tmpfs while it runs. Restarting clears that memory-backed directory; `./devagents start` unlocks it again. Existing Docker `auth.json` credentials migrate automatically: encryption is verified and saved before the old plaintext file is removed. Existing backups/snapshots are not erased by migration.

The API key is never added to project configuration, shell history or the image. Keep both the persistent volume and the OS keychain entry to retain credentials. The keychain entry is scoped to this checkout’s absolute path; moving the checkout or restoring it on another machine requires restoring the matching keychain entry. If that entry is missing while an encrypted vault exists, the service remains available with credentials locked; the launcher does not overwrite them. Both ChatGPT and API-key logins can be reused or changed through the menu. Credential storage does not confirm API credit balance or model access.

Encryption protects the saved file, not a running service from its own OS account or an administrator who can access its memory. Worker sandboxes explicitly deny the credential runtime directory.

Use `./devagents start` after a restart to unlock saved credentials. Plain `docker compose up -d` starts the API but leaves credentials locked until the launcher runs. Linux requires `openssl`, `secret-tool` and an unlocked desktop secret service; there is no plaintext fallback for headless systems without a credential store.

## Native quickstart

Requires Node.js 24.x, npm and Git on macOS/Linux.

```sh
npm ci
npm run dev
```

In another terminal:

```sh
npm run cli -- doctor
npm run cli -- projects add "My project" /absolute/path/to/existing-checkout
npm run cli -- tasks submit my-project "Add a greeting function" --key greeting-1   # add --team <id> to use a saved team
```

The returned task waits for its autonomy choice. Substitute its ID below:

```sh
npm run cli -- tasks mode TASK_ID plan-approval
# The Tech Lead now plans automatically. Wait for awaiting_plan_approval:
npm run cli -- tasks show TASK_ID
# Replace VERSION with the version from the plan you reviewed:
npm run cli -- tasks approve TASK_ID --version VERSION
npm run cli -- tasks events TASK_ID
npm run cli -- tasks evidence TASK_ID
npm run cli -- tasks items TASK_ID
```

Authenticate Codex before selecting a mode. Approve the version you actually reviewed. `tasks cancel TASK_ID` also rejects a pending plan. Submission with `--mode autonomous` skips the mode prompt and plan approval. Task mode overrides project default (`projects add ... --mode ...`), which overrides the global default. With no default the wait is persisted exactly once.

Reuse `--key` with identical input to retry submission without duplication. Use `tasks show` to find the managed branch, worktree path and final commit. The managed branch is named after the request and the task: `devagents/<slug>-<first eight characters of the task id>`, for example `devagents/fix-my-orders-12b1ca2d`; work items use `<task branch>-<item id>`. Branches created by earlier versions (`codex/devagents-<task id>`) stay recognised for diffs and cleanup. The final commit's subject is the first line of the request. Top-level requests run up to `maxConcurrentTasks` (default 1). Within each task, ready items run in deterministic waves bounded by `concurrency` and each role’s `concurrency`. Integration is serial and dependent items start only after prior waves are integrated. Nothing is pushed or merged into the original checkout automatically.

## Browser UI

The service serves the built UI on its own port at `http://127.0.0.1:4310/ui/`; `/` redirects there. Nothing else needs to run. Sign in with a one-time link created through the CLI, which is the only path that holds the long-lived API token:

```sh
npm run cli -- ui            # prints a single-use link valid for 10 minutes; add --open to launch a browser
docker compose exec devagents node dist/cli/main.js ui   # same inside the container
```

In Docker the link carries the published host port (`DEVAGENTS_PORT`, passed to the container as `DEVAGENTS_PUBLIC_PORT`), not the internal 4310. The link sets an `HttpOnly; SameSite=Strict` session cookie. A sign-in lasts until you sign out: it survives laptop sleep and service restarts, because sessions are kept in `<data-directory>/browser-sessions.json` (mode `0600`, beside the CLI token). The service keeps the 20 most recent sessions. For a deployment that is not local, `DEVAGENTS_SESSION_IDLE_HOURS` and `DEVAGENTS_SESSION_MAX_HOURS` restore timed sign-out. The API token itself is never sent to the browser and authentication and provider secrets are never stored in browser storage. U3 keeps an unresolved submission key and its exact task-input payload in tab-scoped `sessionStorage` so retries survive reload and session renewal; do not include secrets in task requests or acceptance criteria.

What U1 shows, all from real service data: an overview with attention items (mode choice, plan approval), the running task with its work items, measured counts and recent outcomes; a filterable, paged task list; a task page with header, plain-language status, work items with stages derived from evidence (implementation runs, test results, review outcome, checkpoints, repairs), the frozen plan, chronological activity with bounded evidence previews, and the result (commit, branch, files, review). Settings reports connection availability without secrets; a saved sign-in is never presented as verified model access. U3 enables registration, submission, mode choice, approval, cancellation, diff inspection and guided setup. Browser cleanup remains disabled until a preview/ownership contract is implemented.

### Saved teams (U2)

Service startup installs an editable **Starter team** with Tech Lead, Frontend Developer, Backend Developer and independent Code Reviewer. The Tech Lead owns architecture and shared contracts, assigns independent frontend/backend items for concurrent execution, and preserves genuine dependencies. Backend also covers assigned tooling and infrastructure; the Tech Lead explicitly selects an integration owner, which may be another suitable specialist. The Work tab shows each specialist's current item and activity. Ready, active starter teams are selected for new projects automatically. Existing untouched projects receive it on upgrade; custom defaults, explicitly cleared defaults, team edits and archives survive restart. Existing saved rosters are not replaced by template changes: edit them in Teams to add specialists. Task snapshots retain their original revisions. The legacy general-developer template remains available for custom teams and historical tasks; QA can be added explicitly if needed.

A team is a saved, named roster: an explicit copy of registry templates and custom roles, stored in SQLite with append-only revisions, never written back to YAML. The Teams page lists active and archived teams with the server's readiness verdict; the editor adds members from a template (copied, not linked) or as a custom role, with labelled fields for name, description, instructions, worker/planner role, engine, provider, model override, capabilities, read/write scope, sandboxed commands and concurrency. Engines, providers and capabilities that this build cannot execute are disabled with the reason; a team whose members name them, or that lacks a planner, a writable implementer or a reviewer distinct from that implementer (the same rule plan validation applies; review itself always runs read-only), saves as a **draft** with per-member diagnostics and cannot receive work. Malformed or forbidden members (path traversal, absolute paths, unsupported glob forms, push) are refused outright. Readiness never consults sign-in or model access; those are verified only by an actual run.

Every save creates a new revision; a save or archive against an older revision is refused with 409 and the browser keeps your input, offering to reload the newer revision or save your edits explicitly on top of it. Duplicate makes an independent copy. Archived teams cannot be edited or chosen for new tasks. A project card sets or clears the project's default team under the project's settings version.

Submission freezes the team: `tasks submit --team <id>` (or `teamId` on `POST /tasks`), otherwise the project default, otherwise the legacy registry. The chosen revision, every member's instructions and permissions, and the concrete engine, provider and provider configuration (never credential values) are copied into the task inside the creation transaction, after the idempotency check, so a retried submission returns the original task even after the team changed. The runner reads only that snapshot: editing, archiving or reconfiguring afterwards cannot change queued, awaiting, running or recovering work. An archived default team fails submission with an actionable error rather than falling back silently. Plan validation remains a separate gate: a plan that assigns an agent outside the team fails before any worker starts. Old tasks and tasks without a team show "Legacy agent configuration"; their agents are snapshotted when the worktree is created, as before.

**Project skills.** DevAgents stores no skills. When a project has `.agents/skills/<folder>/SKILL.md` files, every planning, implementation, QA and review prompt lists them by the `name` and `description` in their front matter and tells the member to read and follow the ones that match its work. The list is taken from the commit the task started at and is the same for Codex and Claude; skills installed in a home folder are not used. Skills are treated as trusted project guidance. Implementers report the skills they followed in `skillsUsed`, and reviewers treat a clear violation of an applicable skill as a finding. Up to 40 skills are listed; descriptions are cut at 500 characters. The project page shows the skills found on `main` (`GET /projects/<id>/skills`); a task's page shows the skills it offered and those reported as followed, from its `project-skills` and `skills-used` evidence. A project without skills, or one whose skills folder cannot be read, runs tasks without them, and both pages say so.

`effort` is `low`, `medium` or `high` and defaults to `medium`. It is passed to Codex as `model_reasoning_effort` and to Claude as the Agent SDK `effort` option; whether a given model honours it is not checked. Team snapshots frozen before the setting existed carry no effort and run at the engine's own default.

`model: default` is not a pinned model: the Codex runtime chooses at execution. Set `defaultModel` in `devagents.yaml` (or a member's model override) to pin team snapshots; without it the task records `modelPinned: false` and the UI says so. DevAgents never guesses a model ID. It asks an engine for its models only when **Refresh list** is used in the member editor (`POST /teams/models/refresh` with `{"engine": "codex" | "claude-code"}`; saved lists: `GET /teams/models`).

CLI: `teams list [--archived|--all]`, `teams templates`, `teams show <id>`, `teams check <file>`, `teams create <file>`, `teams edit <id> <file> --revision N`, `teams archive|restore <id> --revision N`, `teams duplicate <id> <name>`, `projects default-team <project> <team-id|none> --version N`. Team files are YAML or JSON with `name`, `description` and `members` (bounded: 12 members, 64,000 characters of instructions per member and 192,000 bytes in total; template copies are complete, and a roster over the budget is refused with the total stated, never trimmed).

Overview queries active work and attention items independently of recent history. Attention previews show up to 50 tasks and link to the full filtered list. Task state filters apply before pagination; counts cover the selected project across all pages. Request-text search is explicitly limited to the displayed page. Plan approval labels come from persisted approval events, so rejecting a plan never presents it as approved. Large evidence previews retain validation exit/truncation status and review findings counts separately from their text.

The Work tab's **Execution workflow** is chronological, rather than a fixed sequence of roles. Every recorded agent attempt gets a row with its actual agent, scope, start/end time, outcome and report. Review findings remain visible; a subsequent implementation in the same scope links back to unresolved review/QA or validation feedback. These links describe preceding evidence, not a claim that a fix passed. Parallel runs are marked by overlapping run boundaries. Only agent runs receive numbered cards. Consecutive validation results share one expandable summary with pass/fail counts, retaining each command and scope inside it. A later agent run separates validation groups, and repair links target the relevant group. The final local commit is a compact confirmation. These automated entries stay in their recorded order; historical validation records have no start time, so no duration is invented. Interrupted runs remain interrupted, with no fabricated completion. Planned stage assignments are separately expandable.

`GET /tasks/:id/execution` is an authenticated, read-only projection of all execution boundaries, independent of Activity pagination. It selects summaries/findings and command metadata without loading tool logs, prompts, or full agent output. The browser refreshes it every three seconds and retains the last successful timeline with a retry message if an update fails. Historical tasks use existing evidence; no model runs are replayed. Engine badges use the recorded run engine, falling back to the frozen roster. The team overview uses the latest recorded engine per member, and the editor resolves inherited engines from current configuration. Missing historical engine information shows a neutral question mark; badges identify the engine, not verified model access.

Progress updates use bounded polling with exponential backoff. When the service is unreachable the UI shows a disconnected banner with the last update time and keeps the last known state; nothing is invented, and on reconnect history is reconciled by sequence cursor so nothing is duplicated or lost.

Security contract: the UI and API share one origin; every response carries a strict Content Security Policy (`script-src 'self'`, no remote fonts, images or connections), `X-Frame-Options: DENY` and `nosniff`. Cookie sessions are accepted only with a loopback `Host` on the listening port and a same-origin `Origin`/`Sec-Fetch-Site`, so another localhost port or a DNS-rebinding page is refused; state-changing requests additionally need the session's CSRF token. Model text, logs, plans and evidence are rendered as text only: no Markdown, no HTML, no generated links or images. The CLI bearer path is unchanged and still refuses any request carrying an `Origin` header.

Development: `npm run dev:ui` starts a Vite dev server on `127.0.0.1:5173` that proxies API calls to a running service; sign in once through the service's link so the cookie exists. `npm run test:ui` runs the Playwright browser tests against `scripts/ui-fixture.mjs`, a clearly labelled development fixture with a deterministic fake engine on a temporary data directory (run `npx playwright install chromium` once). Browser tests generate representative screenshots in ignored `test-results/ui-screenshots/`; set `DEVAGENTS_UI_SCREENSHOT_DIR` to choose another output directory.

Known limits: Codex/OpenAI and Claude/Anthropic can execute; other provider kinds remain drafts until their adapters exist; the design's Plus Jakarta Sans is not bundled, so the UI uses the system font stack; evidence text previews are capped at 16 KB with a 1 MiB single-entry fetch, accompanied by separately bounded status metadata; updates use polling rather than streaming. Work-item cards show dependencies; there is no graphical dependency editor.

### Usage and cost estimates

Open a task’s **Usage** tab, or read authenticated `GET /tasks/:id/usage`. It groups planning, setup, development, QA and review by work item, with each attempt expandable. It derives all totals directly from retained evidence, including historical tasks and reported usage from failed calls. The endpoint selects only compact run/usage facts, excluding model output and command logs; it does not rely on the browser’s paginated Activity feed. Progress/completion copies of a run’s usage are counted once. Local validation commands do not themselves consume model tokens.

Input includes cached input: total tokens are input + output, not input + cached + output. Missing or invalid usage is unavailable, not zero; missing cached counts prevent pricing. Totals disclose unreported/unpriced runs and remain partial while calls are running. A stopped task with an unfinished call shows that call as interrupted.

**Estimated API cost** and **API-equivalent estimate** are separate totals, never an invoice or actual subscription charge. Saved Codex profiles can contain API keys or ChatGPT sign-ins: new calls record only the billing category parsed from `codex login status`, never its credential-bearing text. Unrecognized and historical saved-login categories remain unknown, grouped with equivalent estimates. Explicit API-key providers are identified as API billing.

New calls snapshot their requested model and USD rates in `run-started` evidence. Built-in reference prices cover `gpt-5.3-codex`, `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6.1-terra` and `gpt-6-luna`, checked against [OpenAI API pricing](https://developers.openai.com/api/docs/pricing) on 2026-11-03. The estimate applies standard-speed, short-context input/cached-input/output rates. It excludes cache-write, long-context and speed premiums, tool fees, taxes and discounts. Historical calls can use labelled reference rates only if their saved model and official OpenAI provider are known; current provider defaults never fill gaps in history. `model: default` remains unknown and unpriced: pin a model in the team for future estimates. Unlisted models show tokens only until configured.

Optional `usagePricing` in the YAML selected by `DEVAGENTS_CONFIG` overrides rates by exact model ID, in USD per million tokens. Example (illustrative custom rates, not a price recommendation):

```yaml
usagePricing:
  models:
    your-pinned-model:
      inputPerMillion: 2
      cachedInputPerMillion: 0.5
      outputPerMillion: 8
      asOf: '2026-11-03'
  # Optional reference conversion; replace with your chosen rate and its date.
  eur:
    usdToEur: 0.9
    asOf: '2026-11-03'
```

Recorded new-run prices do not change when configuration changes. A reference estimate for an older run can change with the available reference rates. EUR is a display conversion: use a configured rate or enter a rate and date in the Usage tab. No live exchange-rate request is made; browser-entered rates last only while that view is mounted. Without a rate/date, EUR estimates are unavailable. Project/monthly rollups, invoices and budget enforcement are not implemented.

### Browser workflows (U3)

1. Open **Projects → Register repository** (`/ui/projects/new`). Supply an existing Git checkout's absolute path as seen by the service. In Docker, mount the checkout and register its container path; the browser does not clone repositories or mount host folders. Refusals preserve your input and show the service's error.
2. Open **Submit task** (`/ui/tasks/new`). Choose a project, describe the change and expected outcome in the request, then choose a ready team or inherit the project default. Drafts and archived teams remain visible with reasons but cannot be selected. A configured project default cannot be bypassed with a legacy-team option. The form shows effective project/service mode defaults; when none exists, the task waits for a mode choice. The accepted panel reports the actual frozen team revision returned by the service.
3. New browser submissions send an empty task-level acceptance-criteria list; the API and generated plan criteria remain supported. The browser saves one key and exact payload per attempt before sending. Stored attempts from earlier versions retain their original payload when retried. Duplicate clicks and edits are blocked while pending or unresolved. A dropped response or 30-second request timeout offers a same-key retry; reload, session renewal and service restart preserve that identity. Other mutations are never replayed automatically. Explicit abandonment warns that the first task may already exist. Confirmed success clears the attempt; **Submit another task** deliberately starts fresh. Closing the tab loses this recovery state.
4. On a task, choose a mode if required. The Plan tab shows the proposed change, assigned member names, planned verification, risks and optional manual checks; work-item implementation details, scope, branches and commands are collapsed under **Technical details**. New planning responses include a plain-language `verification` list alongside the summary, generated in the same call. This list describes the declared checks or inspection; it does not replace validation or claim a pass. Older plans retain their original summary and show a fallback when verification prose is absent. Approval in the header or Plan tab binds to the displayed version; a 409 refreshes the plan and requires a fresh decision. Rejection cancels the task, preserving worktrees. Queued/running tasks can be cancelled; committing cannot. Resubmission from a failed/cancelled task copies only request text, with fresh project/team/mode choices and a new key.
5. Completed results offer **Read-only diff** with green additions, red deletions, blue hunk headers and matching file counts. Original patch text and +/− markers remain intact; file metadata stays neutral and all repository content is escaped text. `GET /tasks/:id/diff` accepts task identity only, verifies the registered repository, task-owned worktree path/branch and recorded base/final commit objects, and disables Git external diff/textconv helpers. Missing or mismatched metadata is unavailable, never an empty diff. Retained completed branches remain inspectable after CLI cleanup if the commits and ownership metadata still exist.

Failed task headers and Result show the saved reason, a next step and a link to Activity. When an implementation produces no reviewable changes, the page explains that DevAgents requires a code change and stops before validation and independent review of that result. The relevant developer report is attributed separately; “already implemented” is not independent verification. This also applies to historical no-change failures without rewriting their records. No-change tasks still fail and create no final task commit; completing verification-only work is not implemented.

Diff display caps are **64 KiB per file, 256 KiB total text, 200 files**, plus a 256 KiB file-list bound and a **1 MiB per-file read bound** and **4 MiB aggregate patch-read budget per request**. Overflowing reads consume their reserved budget even when no text is displayed; subsequent files are marked truncated once it is exhausted. Known secret values are redacted before display truncation. Files exceeding the read bound have their entire text omitted; protected credential-file content is withheld, and binary content is not displayed. File-list overflow returns an explicit unavailable error. Empty, binary, withheld, truncated, unavailable and not-offered states are distinct. There is no patch download, browser cleanup or live/failed-task diff.

**Settings → Guided setup** (`/ui/settings/setup`) separates the browser session, runtime, saved sign-in, model-access verification, project and team. Provider connection is available in the browser or terminal. The host launcher handles project mounts; recovery commands can be copied into your terminal. The setup page accepts a new API key only in a password field and sends it to the local service; it cannot read saved credentials. No paid connection test runs automatically. Submission remains available without a saved sign-in, with a preflight warning. Model pinning and frozen-team semantics are unchanged.

## Task branches and starting commits

**A project connected to GitHub starts from GitHub.** Right before a task's worktree is created, the service fetches the project's target branch (the one set under "After a task finishes", otherwise the repository's default branch) and the task starts from that commit. The fetch goes into a reference DevAgents owns (`refs/devagents/remote/<branch>`): your local branches, remote-tracking references and working files are not touched, and commits that exist only in your local `main` are not part of the task. If the branch cannot be fetched, the task fails with that reason and does not fall back to local `main`. The task page shows "Started from `<branch>` on GitHub at `<commit>`", recorded as `task-start` evidence.

**A project without a GitHub connection starts from local `main`,** as described in the rest of this section.

Every newly created task worktree starts from an explicitly resolved `refs/heads/main^{commit}`. The service resolves this at creation time, so registration does not freeze the starting commit. It creates a new `devagents/<request-slug>-<short-task-id>` branch with `git worktree add -b`; existing branches are never reset or reused. A missing local `main` is an actionable error, with no fallback to `HEAD`, a previous task branch or `origin/main`. No automatic fetch, pull, merge or modification of the original checkout occurs. Local staged, unstaged, untracked and ignored files are not copied into the task worktree.

The recorded `workspace.baseSha` is the immutable task starting commit. `workspace.originalHead` separately records the original checkout HEAD for divergence checks and review evidence, because that checkout may be on another branch. Legacy workspaces without this field retain their existing HEAD check and starting commit. Existing tasks are not rebased by an upgrade. Worker branches within one task still start from private dependency checkpoints rooted in that task, preserving completed prerequisite work.

## Multi-agent plans and progress

The Tech Lead chooses up to 30 work items with assigned agents, dependencies, validation commands, managed branches and `ownedPaths`. Its built-in instructions favor targeted inspection, the smallest useful plan and concise structured output; required verification blockers cannot be waived as optional limitations. Each item needs a writable implementer with the required capabilities, and review must be independent of all implementers and the integrator. Multi-item plans need combined validation; single-item plans use item validation and `integration: null`. Planning and execution use the task's frozen policy. With extra rules off (the default), owned paths describe the planned scope; the engine can write elsewhere within its isolated worktree. With extra rules on, owned paths are enforced, may only narrow role permissions, and Linux write grants must be directory subtrees such as `project:/src/component/**`. Unsupported plans are refused before approval.

Use `tasks show TASK_ID` to inspect and approve the plan, `tasks items TASK_ID` for each item’s progress/worktree/commit, and `tasks evidence TASK_ID` for runs, validation, checkpoints and integration decisions. A plan-approval wait stops that task’s implementation and releases its task slot; unrelated tasks can continue. For parallel work by one role, set that role’s `concurrency` above 1; different roles can run concurrently at their existing limits.

Each worker branches from a private snapshot of results already integrated into the task worktree. Successful item validation and independent review produce a private work-item commit. These commits and dependency checkpoints are intermediate evidence, not final task approval. Changes are combined with three-way patch application in the task worktree. Conflicts become an explicit integration-agent repair bounded by `maxRepairCycles`. A repair counts as resolved only when the file content is clean: any `<<<<<<<`, `|||||||` or `>>>>>>>` line fails it, and a bare `=======` line fails it when the file has more of them than either side had before the merge, so Markdown heading underlines are allowed while leftover dividers are not; Git must also report no unmerged entry. Unresolved conflicts stop the task; terminal cleanup preserves unfinished work in recovery snapshots. Repository-defined filters and custom merge drivers are refused.

After integration, all item checks and the combined checks run again. A reviewer distinct from all implementers and the integration agent must approve the complete diff before one final commit is created on the task branch. Per-item repair budgets and a separate shared integration repair budget are bounded. The runtime routes routine findings to the already assigned developer or integration owner without another Tech Lead call. Contract changes or ownership conflicts must be reported rather than silently changing the approved plan; automatic Tech Lead replanning is not implemented. Completion follows the enforced gates, not an agent declaration. Cancellation or failure drains sibling workers and blocks unstarted dependents; item evidence records why each worker stopped (`failed`, `aborted` by a sibling failure, `cancelled` by the user, or `interrupted` by a service shutdown). A private checkpoint may already exist when cancellation arrives; a cancelled task never advances to the final combined commit. Restart recovery preserves paths/evidence and marks interrupted tasks failed rather than replaying them automatically. Terminal tasks automatically reclaim generated resources and remove owned worktrees after workers drain. Dirty work is archived first; branches and task history survive. The explicit `tasks cleanup TASK_ID` command removes only worktrees registered under the data directory for that task and only task-owned branches (current `devagents/<slug>-<short-id>` and legacy `codex/devagents-<task-id>…` names), keeps a completed task’s branch (the reviewed commit), and records what it removed as evidence. It refuses active tasks and anything it cannot prove it created.

## Configuration and agents

### Optional extra rules

`devagentsRules: false` is the default for new tasks. Set `devagentsRules: true` in the service YAML configuration to add DevAgents' command allowlist, role read/write/shell restrictions, per-item write scopes, read-only validation, ignored-file mutation checks and blanket symlink denials. Environment variable `DEVAGENTS_RULES=true|false` overrides YAML; invalid values stop startup. Docker Compose supplies `false` by default. For persistent Docker configuration, set `DEVAGENTS_RULES=true` in the repository's `.env`, then run `./devagents start`.

The flag is frozen transactionally at task submission, after idempotency lookup, and recorded in run evidence. Existing tasks without a flag retain their original strict behavior; retrying the same submission key never changes it. Settings shows the service default and the task page shows the frozen value. Submit a new task to use a new default. No browser or model-provided task input can override it.

This is an extra-policy toggle, not an unrestricted execution switch: worktree and credential boundaries, no automatic pushes/merges/deployments, task/plan integrity, real validation, independent review, resource limits and browser authentication remain mandatory. Engine-denied operations still fail; there is no unsandboxed fallback. Codex and Claude execute through registered adapters with the same workspace boundaries.

`DEVAGENTS_DATA_DIR` defaults to `.devagents`, and `DEVAGENTS_PORT` to `4310`. Set `DEVAGENTS_CONFIG` to a YAML file such as `examples/devagents.yaml`. The default OpenAI provider uses the saved Codex profile (including a saved API key); an explicitly configured `auth: api-key` with `apiKeyEnv` instead selects the existing environment-variable flow. The native process does not automatically load `.env`; `.env.example` documents variables. Compose uses `.env` for substitution only.

Six built-ins: Tech Lead, Developer, Backend Developer, Frontend Developer, QA Engineer and Code Reviewer. The Code Reviewer template keeps review read-only and scoped to the item or combined gate, prioritizes evidence-backed defects, and separates repair findings from optional comments and limitations. Its structured report uses `approved`, `summary`, `findings` and `limitations`; approval requires no actionable findings and does not authorize deployment. The Backend Developer template emphasizes API contracts, security, data consistency, focused checks and concise handoffs; integration requires explicit Tech Lead assignment. The Frontend Developer template favors existing components, responsive and accessible UI states, focused checks and concise structured handoffs. Test doubles can support independent implementation but do not prove real backend integration; unavailable required verification remains a blocker. Add YAML and Markdown under `<data-directory>/agents/` or `<project>/.devagents/agents/`. Precedence is project > user > bundled `agents/builtin/`. Duplicate IDs within a directory fail validation. Definitions reload when the registry is requested and are snapshotted when a legacy task creates its worktree; saved teams copy them at edit time instead (see [Saved teams](#saved-teams-u2)). `defaultModel` optionally pins the model recorded in team snapshots.

```yaml
schemaVersion: 1
id: technical-writer
name: Technical Writer
description: Writes and reviews project documentation
engine: codex
provider: openai
model: default
effort: medium
capabilities: [documentation, filesystem-read, filesystem-write]
instructionsFile: ./technical-writer.md
delegation:
  canReceiveTasks: true
  canDelegate: false
permissions:
  readPaths: ["project:/**"]
  writePaths: ["project:/docs/**"]
  allowCommands: false
  allowPush: false
```

Inspect with `npm run cli -- agents --project my-project`. Naming an agent does not install tools. Graphic Designer with `asset-design` is rejected until a real design backend is connected. Provider/model and coding-engine selection are separate. Local endpoint configurations are accepted for future use; local inference is not implemented.

## Project names and IDs

A project has a **name** and an **ID**. The name is free text (up to 80 characters), is what every page and message shows, and can be changed at any time; it is unique among active projects, compared without regard to case. The ID is a UUID generated by the service. It is the key that tasks reference and is never chosen, typed or changed.

- Register with a name: the browser form, `./devagents project add --name 'My project' --path …`, or `devagents projects add "My project" /path`. The API refuses a hand-written ID (`invalid_project_id`).
- Rename: "Rename" on the project page, or `devagents projects rename <project> "New name"`. Renaming changes nothing else: ID, history, folder and connections stay.
- Terminal commands take a project by **name or ID** (`tasks submit "My project" "…"`, `integrations show "My project"`, `projects archive "My project"`). If two projects share a name because one is archived, the active one is meant; otherwise the command asks for the ID.
- Task responses carry `projectId` and the project's current `projectName`.

In Docker a project's folder has two addresses: the folder on your computer and the path it is attached at inside the container (`/projects/…`). The launcher reports the first to the service on every start (`projects sync-folders`, `PUT /projects/host-folders`, bearer only), and pages show that one, with the internal path as a detail. The internal path of a project never changes, also not when the project is renamed.

Projects registered before IDs were generated had a hand-written ID such as `my-project`. Opening such a database converts it once (schema 7): the project gets a UUID, the old ID becomes its name, and its tasks and stored plans follow. Folders, mounts, branches and worktrees are not touched, because none of them was keyed by the ID; in Docker the folder stays attached at its old path. Text already written to the append-only history keeps the old ID.

The other tables already used UUIDs (tasks, teams) or plain row counters that only order an append-only log (events, evidence).

## Archiving and restoring a project

A project cannot be deleted, because its task history is stored under its ID. It can be **archived**: taken out of use while everything it produced stays readable. The usual reason is to register the same repository again under a new ID with another team, mode or connections.

| | Archived project |
| --- | --- |
| Kept | Its tasks with plans, activity, results and diffs; the task branches in the repository; its ID, default team and mode |
| Removed | Its GitHub and Jira connections. A token another project still uses stays saved |
| Stops | New tasks, and new connections, for that project. It leaves the Projects list and the project picker |
| Needs | Every task of the project to be finished or cancelled; open work is never cancelled for you |

After archiving, the folder can be registered again as a new project. To change only what a project is called, rename it instead.

**Restoring** brings the project back as it was, without its connections. One folder belongs to one active project at a time, so restoring is refused while an active project is registered on the same folder; archive that one first. Two projects are on the same folder when their paths are equal or lead to the same directory, which is how one host folder mounted under two IDs in Docker is recognised.

In Docker, archiving leaves the folder attached under the old ID, so archived tasks keep their diffs and nothing restarts. `./devagents project add` accepts a folder that is attached only to archived projects and attaches it a second time under the new ID.

```sh
./devagents project archive --name 'My project'      # Docker launcher; name or ID
./devagents project restore --name 'My project'
devagents projects archive <project>                  # service CLI; name or ID
devagents projects restore <project>
devagents projects list [--archived | --all]
```

Browser: the project page (Projects → **Integrations →**) has "Archive project…"; Projects lists archived projects with "Restore". API: `POST /projects/:id/archive` with `{ "archived": true|false, "expectedVersion": n }`; `GET /projects?filter=active|archived|all` (default `active`). A task of an archived project carries `projectArchived: true`.

## Project integrations

Each project can be connected to GitHub and to Jira. Both are optional and independent. Other ticket tools are connected through their MCP server; see [Ticket tools](#ticket-tools-any-jira-like-tool-with-an-mcp-server). Connecting stores and checks configuration. DevAgents does not comment on tickets or start tasks from tickets on its own, and a task still ends in a local commit. A project connected to GitHub can then publish that commit as a pull request; see [Pull requests](#pull-requests). The browser page is Projects → **Integrations** (`/ui/projects/<id>`).

| | GitHub | Jira |
| --- | --- | --- |
| Token | A personal access token: `github_pat_…` (fine-grained) or `ghp_…` (classic) | Jira Cloud: an Atlassian API token together with the site and the account's email. Self-hosted Jira (Data Center): a personal access token and the address, no email |
| What is checked | The token's account, and that it can see the repository | The token's account. A Jira Cloud token created "with scopes" is detected and used through `api.atlassian.com` |
| What is saved | `owner/name`, read from the registered folder's `origin` remote (or given explicitly), the login, whether the token can push, and the end date GitHub reports | Site, account, an optional end date you enter (Jira does not report one), and the pick-up rule |

The **pick-up rule** names one Jira project and at least one of: a board column, an assignee, a label. In the browser, project, assignee and label are type-ahead fields that search Jira as you type (`GET …/jira/suggest?kind=projects|people|labels&query=…`, people also need `project=KEY`; `integrations jira search <project> <kind> [text]` in the terminal), so they work in a Jira with more projects and people than a list can hold. A label that is not suggested can be entered as typed. Columns come from the project's first board; a project without a board offers its statuses. Saving a rule first runs it in Jira, so a saved rule is one Jira accepts, and the response says how many tickets match now. `start` records whether a matching ticket should wait for a person (`manual`, the default) or start on its own (`auto`); nothing reads it yet.

A connection shows one state: `connected`, `expiring` (14 days or fewer left), `expired`, `rejected` or `unreachable` (after a failed check), or `locked` (vault not unlocked). Checks run when you connect and when you ask; there is no background polling.

**One token per account.** A token is saved once, under the account it belongs to (the GitHub login; for Jira the site and account), and shared by every project connected to that account. Connecting another project offers the saved token, so nothing is pasted again (`savedToken` in the API, `--saved-token <id>` in the terminal; the ids are listed under `savedTokens` in the integrations view). Replacing the token on one project replaces it for all of them, a refused token is shown on all of them, and the token is deleted when the last project using it disconnects. Each project still keeps its own repository and its own pick-up rule.

**Tokens.** A token is write-only: it is sent once, verified, and never returned by any route. With the Docker launcher it is encrypted with the vault's master key under `<data-directory>/credentials/integrations/` and decrypted in memory only when a request needs it. A native service has no encrypted store, so a pasted token is refused; set `DEVAGENTS_GITHUB_TOKEN_<PROJECT_ID>` or `DEVAGENTS_JIRA_TOKEN_<PROJECT_ID>` (project id in upper case, dashes as underscores) in the service's environment and connect without a token. These are one variable per project and are not shared. Requests to GitHub and Jira never follow redirects, and a Jira address must be `https`.

Terminal (in Docker, prefix with `docker compose exec devagents node dist/cli/main.js`; natively `npm run cli --`):

```sh
devagents integrations show <project>
devagents integrations github connect <project> [--repository owner/name] [--token-env NAME | --saved-token ID | --keep-token]
devagents integrations github check|disconnect <project>
devagents integrations jira connect <project> --site example.atlassian.net --email you@example.com [--expires YYYY-MM-DD]
devagents integrations jira connect <project> --site https://jira.example.com --self-hosted
devagents integrations jira connect <project> --saved-token ID
devagents integrations jira options <project> [--project KEY]
devagents integrations jira rule <project> --project KEY [--column NAME] [--assignee NAME_OR_ID] [--label LABEL] [--start manual|auto] [--preview]
devagents integrations jira check|disconnect <project>
```

`connect` asks for the token in a hidden prompt; `--token-env` reads it from an environment variable instead. A token is never a command-line argument. `rule --preview` shows what a rule matches without saving it.

API: `GET /projects/:id/integrations`; `PUT`/`DELETE /projects/:id/integrations/github|jira`; `POST …/github|jira/check`; `GET …/jira/options[?project=KEY]`; `POST …/jira/preview`; `PUT …/jira/rule`. They use the same bearer or session-plus-CSRF rules as every other route. Settings live in the project's record; the project `version` is not changed by them.

The GitHub and Jira calls are covered by deterministic fixtures only. They have not been run against the real services.

## Pull requests

A project that is connected to GitHub shows **After a task finishes** on its page, with four steps that are each `Off` (the default), `Ask me` or `Automatic`: **Publish**, **Fix failed checks**, **Fix review comments** and **Merge**. The last three need Publish. **Target branch** is the branch pull requests open into; without one, the repository's default branch is used. **Automatic fix rounds, at most** (1 to 5, default 3) limits what DevAgents starts on its own for one pull request. **Merge method** is squash (the default), merge commit or rebase.

- **Ask me:** a completed task gets a **Pull request** tab with **Open pull request**.
- **Automatic:** a completed task is published within about 15 seconds. A publish that fails is recorded on the tab and waits for a click; it is not retried on its own.
- A task keeps the choices its project had when the task was submitted. A click is also offered for a task that was finished before Publish was turned on.

Publishing pushes the task's commit to a branch of the same name in the connected repository and opens a pull request that is ready for review. DevAgents never opens a draft, because review tools that watch a repository skip drafts. Its title is the first line of the request; its body is the task's result summary and the task ID.

- Only the task's own `devagents/…` branch is pushed, never with force. A branch of that name that already holds other commits is left alone and the publish fails.
- Before each step GitHub is asked what exists, so a repeated or interrupted publish neither pushes twice nor opens a second pull request.
- The token is sent to Git as an HTTP header through the environment. It is never in a command line, a URL or a Git config file, and your checkout gets no remote and no changed branch.
- The token needs read and write access to **Contents** and **Pull requests** of the repository. Merging uses the same access.
- The task records `pull-request-settings`, `pull-request-pushed`, `pull-request-opened`, `pull-request-failed` and, for fix rounds, `pull-request-round`, `-round-pushed`, `-round-held` and `-round-failed`, and for merging `pull-request-merged` and `pull-request-merge-failed`, as evidence, visible under Activity.

**Reading GitHub.** While a pull request is open, the service reads it about once a minute: its state, the checks on its latest commit (check runs and commit statuses), whether it can be merged, and its unresolved review threads. A merged or closed pull request is not read again.

- The task's **Pull request** tab shows the result: one status, the checks with GitHub's own short result line, and the open review comments. The task header and the board card carry the same status, for example `PR #42 · 1 check failed`.
- The status names the first thing in the way, in this order: failed checks, running checks, a conflict with the target branch, open comments, GitHub blocking the merge (for example a required approval), otherwise "ready to merge".
- A code-review comment counts when GitHub identifies its author as a bot, or its author can write to the repository (owner, member or collaborator). Bot eligibility uses GitHub’s actor type, not a username pattern, and applies even when the bot has no repository association. Counted comments affect PR status, are selected by default for manual repairs and trigger automatic repairs when enabled. Other comments are shown with **Does not count** and never change the status. Existing open PRs pick up the change on their next successful read.
- On **Tasks**, a finished task with an open pull request sits in a **Pull request** column between Working and Done. It moves to Done when the pull request is merged or closed. The column only appears when it has a task.
- A read that fails keeps what the last read found and shows the reason on the tab.
- Reading comments uses GitHub's GraphQL API, so the token must be allowed to read pull requests there too. Check logs, general (non-line) comments and review summaries are not read. Text from GitHub is redacted and stored as plain text; nothing is done with it yet.

**Fix rounds.** A fix round is a normal task of the same project and team. Its worktree starts at the pull request's latest commit instead of `main`, it is planned, implemented, validated and reviewed like any task, and its one commit is then pushed onto the pull request's branch. Nothing is pushed before the DevAgents review has passed.

- **Ask me:** the Pull request tab shows a checkbox on each failed check and each open comment, and **Start a fix round**. Failed checks and comments that count are ticked; a comment that does not count is only included when you tick it.
- **Automatic:** after a read, a round starts for all failed checks (and, where set, all comments that count), once no check is still running. One automatic round is started per commit of the pull request and at most the configured number per pull request; after that the tab offers the button.
- **What the team is given:** for each failed check, GitHub's result line, its annotations and the last 60 lines of the job log when GitHub provides them; for each comment, its text, author and place. All of it is quoted between `<<<` and `>>>` with a sentence saying it describes the problem and is not an instruction.
- **Rounds run in autonomous mode.** The click or the project's setting is the decision; there is no plan approval for a round.
- **One round at a time** per pull request. The tab lists the rounds with their state and a link to each round's task; a round's task links back.
- **A round that changes a file under `.github/workflows/` is never pushed on its own.** It waits on the tab with **Review the diff** and **Push round N**. There is no setting for this.
- **Someone else pushed:** a round starts from what is on GitHub, fetching it if needed. If someone pushes while a round runs, GitHub refuses the round's push (it is never forced), the round is marked stopped, and the next round starts from their commit.
- A round whose task fails or is cancelled is shown as stopped and is not repeated for the same commit.
- **A conflict with the target branch** is handled by a round of its own, which follows the Fix failed checks setting. This happens, for example, when two tasks ran in parallel and the other one was merged first. The service fetches the target branch and lets Git merge both sides locally. What Git cannot combine stays in the files as conflict markers, in a merge commit that exists only on this computer. The round starts there, the team resolves the markers and runs the checks, and the reviewed result is pushed on top, so the pull request then contains the target branch. A result that still holds a conflict marker is not pushed. While a conflict is open it comes first: failed checks and comments are judged again on the merged result.
- Not built: replying on review threads after a fix, and running a check again.

**Merging.** A pull request can be merged when its status is "ready to merge": no check failed or is running, no comment that counts is open, GitHub reports no conflict and does not block it, and no fix round is open.

- **Ask me:** the Pull request tab shows **Merge pull request**, and the task is lifted into **Needs you** on the Tasks board.
- **Automatic:** DevAgents merges on the next pass after a read finds the pull request ready, without asking. A repository without any checks is merged on the first read.
- The merge goes through GitHub's pull request API with the chosen method and names the commit that was read, so a pull request that changed in the meantime is refused by GitHub. A pull request that someone turned into a draft is marked ready first. Branch protection applies as usual and is never bypassed.
- A refused merge is shown on the tab with the reason. An automatic merge is attempted once per commit; after a refusal it waits for a click and the task appears in Needs you.
- After a merge the tab says so. Your checkout is not changed: when the local target branch does not hold the merge, the tab shows `git pull`.
- **Needs you** on the Tasks board also lists pull requests where a fix changes a workflow file, a fix round waits for a decision, the automatic round limit is reached, or the last automatic round stopped.
- Not built: running an unrelated failed check again, and deleting the merged branch (left to the repository's own setting).

| Route | Purpose |
| --- | --- |
| `GET /projects/<id>/pull-requests` | Whether GitHub is connected, and the saved choices |
| `PUT /projects/<id>/pull-requests` | Save `{ "publish", "fixChecks", "fixComments": "off" \| "ask" \| "auto", "maxFixRounds"?: 1–5, "merge"?: "off" \| "ask" \| "auto", "mergeMethod"?: "squash" \| "merge" \| "rebase", "targetBranch"?: "<branch>" }` |
| `GET /projects/<id>/pull-requests/branches` | Branch names read from GitHub, and the default branch |
| `GET /tasks/<id>/pull-request` | The task's choice, whether a click can publish it, the pull request or the last failure, and under `github` what was last read |
| `GET /tasks?pullRequest=open` | Only tasks whose pull request is open; every task summary carries `pullRequest` when it has one |
| `POST /tasks/<id>/pull-request` | Publish now |
| `POST /tasks/<id>/pull-request/rounds` | Start a fix round for `{ "checks": ["<name>"], "comments": ["<thread id>"] }`, or `{ "conflict": true }` to resolve a conflict with the target branch |
| `POST /tasks/<id>/pull-request/merge` | Merge now |
| `POST /tasks/<id>/pull-request/push-round` | Push the round that waits because it changes a workflow file |

There are no terminal commands for this yet. Not verified against the real GitHub: the push and the API calls are tested with a local bare repository and recorded answers.

## Task board and available tickets

The Tasks page (`/ui/tasks`) opens as a board; a **Board / List** switch keeps the table, and the choice is remembered per browser. `?view=list` or `?view=board` picks one, and a link with `?group=…` opens the list.

- **Needs you** is a band above the board: tasks waiting for a mode choice, a plan approval or an external approval, each with its one action. A task is in the band or in a column, never both, and the band is absent when nothing waits.
- **Columns** group the task states: Planning (`draft`, `planning`), Queued (`ready`), Working (`running`, `validating`, `reviewing`, `repairing`, `committing`), Done (`completed`), Stopped (`failed`, `cancelled`). The chip on a card names the exact state. Done and Stopped show the newest eight and link to the list for older ones. Once started, a task follows its recorded backend state; dragging cannot skip execution or approval gates.
- **Available** is the first column and holds tickets, not tasks: every ticket that a project's saved Jira rule or ticket-tool rule matches now and that has no task yet. A card names its source and ticket number (a link to the ticket), the rule values it matched and the project it is for.
- **The pin** in the corner of Available keeps the column open. Unpinned, it folds to a strip that opens over the board while the pointer or the keyboard focus is on it; Escape closes it.
- **Dragging a ticket into Planning** (or pressing its **Start task** button) reads the full ticket and submits it immediately, staying on the board. It inherits the project’s default team and effective autonomy mode; if no mode is configured, it uses plan approval. The column shows “Starting…” until the service responds, then the task’s actual state. Ticket-read failures leave the ticket available. An uncertain submission offers a same-key, same-payload retry that survives reload; resolve it before starting another ticket. Other columns do not accept drops.
- **Clicking a ticket** opens the Submit work form with everything preselected: the request, the project's default team and its usual autonomy mode. The request, team and mode can be changed. The project is shown but not offered as a choice, because the ticket's rule belongs to that project. Nothing starts until the form is submitted.
- **A ticket counts as started** while a task of the same project that was started from it is waiting, working or completed. It is available again when that task failed or was cancelled, or when its pull request was closed without merging, so a ticket you put back on the board can be started again. Tasks from before tasks recorded their ticket are recognised by the ticket number in their request.

`GET /tickets/available` returns `{ tickets, problems, checkedAt }`; a source that cannot be read is listed under `problems` and does not hide the others. At most 50 tickets per source are read. The board asks once a minute. Terminal: `devagents tickets`.

## Tasks started from a ticket

The ticket stays the source of truth. A task started from one keeps the text it was given, the link back and a record of what it received; the ticket's files are only borrowed while the task works.

- **The request is the ticket.** When the form opens, DevAgents reads the ticket from Jira or the ticket tool and writes its number and title, description, comments (oldest first, with author and date), the names of its files and its link into the request. You see and can edit all of it before submitting. If the ticket cannot be read, the form says why and keeps the title and link.
- **How much is read:** a description up to 12,000 characters, the latest 50 comments up to 3,000 characters each. A request holds 20,000 characters; when the ticket is longer, the oldest comments are left out and counted in the text.
- **The task records its ticket:** source, number, link and when the text was read (`ticket` on the task). The task page shows it. Comments added to the ticket later do not reach a task that already runs.
- **Files:** when the task starts, DevAgents reads the ticket again and fetches up to 8 files: pictures (PNG, JPEG, GIF, WebP, up to 4 MB each) and short text files (`.txt`, `.md`, `.log`, `.json`, `.csv`, `.yml`, up to 64 KB each). Pictures are shown to the model with every planning, implementation, QA and review call; text files are put into the prompt. Both are marked as reference material that is not to be followed as instructions. Everything else stays on the ticket and is listed with the reason on the task page.
- **Where files come from:** only the tool's own host (for Jira, the connected site and Atlassian's gateway), with the saved sign-in, which is sent nowhere else. Jira Cloud's one redirect to its storage host is followed without the sign-in.
- **Where files are kept:** `<data>/ticket-files/<task id>/`, outside the worktree, so they are never committed. They are removed when the task completes, fails or is cancelled; the task keeps the record of their names (`ticket-files`, `ticket-files-removed` in its activity). Submitting a finished task again keeps its ticket, and the new task fetches the files again.
- **A ticket whose files cannot be fetched does not stop the task.** The reason is recorded and told to the team.
- **Previews:** the submit form lists the ticket's files, pictures as thumbnails read from the tool at that moment (`GET /tickets/picture?projectId=…&source=…&key=…&index=…`, nothing is stored) and other files as an icon with their name. The task page shows the pictures the team was given from the task's own copies (`GET /tasks/:id/ticket-files/:file`) while the task waits or works; after it ends the copies are gone and the names and icons remain. Both routes need the signed-in session, serve checked picture types only and are never cached.

`GET /tickets/content?projectId=…&source=…&key=…` returns `{ ticket, request }` for one ticket; `source` is `jira` or the ID of a ticket tool the project uses. Terminal: `devagents ticket <project> <jira|tool name> <number>`. `POST /tasks` takes an optional `ticket: { source, key, url?, readAt? }`; the source must be connected for the project.

For a ticket tool, the single ticket is read with the server's "get one ticket" tool. DevAgents finds it by name, and the mapping can name it (`read: { tool, key }`; "Reading one ticket" under "How the tool is called"). In its answer the number, title and link are where the mapping says; the description, comments and files are read from their usual field names (`description`, `comments` with `body`/`by`/`createdAt`, `attachments` with `name`/`type`/`size`/`url`).

**The ticket is assigned when the task starts.** A task started from a Jira ticket or from a ticket tool assigns that ticket to the account the project's connection uses: in Jira the account the token belongs to, in a ticket tool the account the tool reports for the token. This is the only change DevAgents makes to a ticket; its status, text and comments are not touched.

- In Jira the token must be allowed to edit issues (scope `write:jira-work` for a token created "with scopes").
- In a ticket tool DevAgents looks for a tool that updates a ticket and takes an assignee (for example `pulse_update_task`), and sends the ticket number, the account, and a request id where the tool has an argument for one. A mapping can name the tool under `assign` (`tool`, `key`, `assignee`, optional `operation`).
- Assigning never holds the task up. The task page shows "assigned to …" on the ticket line, or a warning with the reason when it did not work; both are recorded as `ticket-assigned` or `ticket-assign-failed` evidence.

## Ticket tools (any Jira-like tool with an MCP server)

Besides the built-in Jira connection, any ticket tool that offers an MCP server can be connected. DevAgents knows no particular tool: a **mapping** says which of the server's tools lists tickets and where the ticket fields are in its answer. Tickets are read, never changed: no task starts from a ticket by itself and nothing is written to the tool.

A tool is added **once** (Tools in the sidebar, `/ui/tools`) and then used by any number of projects, each with its own pick-up rule (Projects → **Integrations** → Ticket tool). A project can use several tools, next to the optional Jira connection; an added tool is chosen from a list, so its address and token are never entered again.

1. **Add the tool.** Give it a name, the https address of its MCP server and a token (a personal API key or access token of the tool, sent as a bearer token). DevAgents signs in, lists the server's tools and calls the one that looks like a ticket list.
2. **Confirm seven fields.** The page shows what DevAgents reads from a ticket: ticket number, title and link (to name the ticket and link back), and project, status, assignee and label (to choose which tickets come in). Each row shows the tool's field and its value on one real ticket, so a wrong guess is visible; a field that is not chosen says what stops working. Everything else in the mapping is filled in automatically and folded under "How the tool is called". Saving calls the tool again through the mapping, so a saved mapping is one that works.
3. **Connect a project and set its rule.** Choose any number of projects, columns, assignees and labels, as far as the tool supports them, with a live count of matching tickets. Every choice is optional.

The mapping has four parts:

| Part | Meaning |
| --- | --- |
| `list.tool`, `list.fixed` | The tool that lists tickets, and arguments sent with every call (for example `assignment: all` where the tool defaults to the caller's own tickets). |
| `list.filters` | Which argument takes the rule's project, column, label or assignee, and whether it expects a list. A filter with no argument is applied by DevAgents to the returned tickets. |
| `result` | Where the answer holds the tickets and, when present, projects, labels, people and the signed-in account. Paths are field names joined by dots (`data.tasks`). |
| `ticket` | Fields of one ticket: `key` and `title` are required; `column`, `project`, `assignee`, `labels` and `url` are optional. |
| `columns` | Columns a rule can name, in board order. Left empty, the columns seen on tickets are offered. |

Rules of the connection:

- **The address must be https** without credentials, query or fragment, and redirects are not followed, so the token is only ever sent encrypted and to that address. **Plain http is accepted only for a tool on this computer:** `localhost`, `*.localhost`, `127.x.x.x`, `[::1]` and `host.docker.internal` (the host as the Docker service sees it). Any other host, such as a staging or production address, needs https.
- **The token is write-only** and stored like the other integration tokens, under `tracker-<name>`. Native installs read it from `DEVAGENTS_TRACKER_TOKEN_<NAME>`; a pasted token is refused there.
- **A rule has four optional parts, each with several values:** projects, columns, assignees and labels. A ticket matches a part when it has any one of its values, and it must match every part that is filled in. With nothing filled in, the rule means every ticket the account can see.
- **A rule only offers filters the mapping can answer**, by an argument or by a ticket field. One value goes to the tool's own filter; several columns go to it as a list; several projects, people or labels are checked by DevAgents on the returned tickets, because a tool may read a list there as "all of these".
- **Labels on tickets count as choices** even when the tool does not list them.
- **A tool must return structured data.** One that answers only with prose cannot be mapped.
- **A rule can be removed** ("Remove rule", or `remove-rule` in the terminal) while the connection stays; without a rule no tickets come from that source. The Jira rule can be removed the same way: `devagents integrations jira remove-rule <project>`. In the Jira rule every field can be emptied: a project alone means its open tickets, and saving with no project removes the rule.
- **A tool cannot be removed while a project uses it.** Archiving a project drops its connection.
- Everything a server sends is treated as remote content: only mapped fields are read, as short plain text.

```bash
devagents tools add "Team board" https://tracker.example.com/mcp     # hidden token prompt, or --token-env NAME
devagents tools inspect "Team board"                                # the server's tools, the answer's outline, the proposed mapping
devagents tools map "Team board" --suggested                        # or --file mapping.json
devagents tools list | show | check | rename | address | token | remove
devagents integrations tool list <project>
devagents integrations tool connect <project> "Team board"
devagents integrations tool options <project> "Team board"
devagents integrations tool rule <project> "Team board" --project Website Shop --column todo in-progress --label devagents [--preview] [--start auto]
devagents integrations tool remove-rule <project> "Team board"   # keep the connection, bring in no tickets
devagents integrations tool disconnect <project> "Team board"
```

API: `GET|POST /trackers`; `GET|PUT|DELETE /trackers/:id` (`PUT` takes any of `{ name, url, token }`; a new address or token is verified before it is saved, and the mapping is kept); `GET /trackers/:id/inspect`; `PUT /trackers/:id/mapping`; `POST /trackers/:id/check`; and per project `GET /projects/:id/integrations/trackers`, `PUT|DELETE …/trackers/:toolId`, `GET …/trackers/:toolId/options`, `POST …/trackers/:toolId/preview`, `PUT|DELETE …/trackers/:toolId/rule`. The Jira rule has `DELETE /projects/:id/integrations/jira/rule`. Tools are stored in the `trackers` table (database schema 8).

Not included yet: browser sign-in (OAuth) for servers that do not accept a token, starting tasks from tickets, and writing comments or column changes back.

## Authentication

Codex uses a dedicated profile with ChatGPT device login or an OpenAI API key. With the native service already running, use the same guided authentication setup:

```sh
npm run cli -- auth setup
# Or select ChatGPT directly:
npm run cli -- auth setup --auth chatgpt
# Reuse credentials and explicitly test model access:
npm run cli -- auth setup --auth saved --test-connection
```

Native logins use Codex’s OS keyring backend with a dedicated DevAgents profile; they do not create a new plaintext credential file. A working OS credential store is required. The existing explicit login methods are also available:

```sh
npm run cli -- auth codex
# Or, with OPENAI_API_KEY already securely set in this terminal:
npm run cli -- auth codex --api-key-env OPENAI_API_KEY
```

In Docker:

```sh
docker compose exec devagents node dist/cli/main.js auth codex
# For API-key login, inherit the already-set variable only for this process:
docker compose exec -e OPENAI_API_KEY devagents node dist/cli/main.js auth codex --api-key-env OPENAI_API_KEY
```

Never put literal keys in commands, YAML, commits or task requests. Login state stays in the dedicated data directory/volume; host credentials are not copied. Device login may require account/workspace enablement. Dedicated container API-key login and ChatGPT device login are verified. The live M2 and M3 model fixtures passed with ChatGPT sign-in on 2026-10-29 and passed again against the post-review baseline on 2026-10-30; earlier API-key attempts were blocked by API quota. A missing login fails the task with a setup error before creating a worktree; after login, submit a new task with a new retry key.

Claude supports API-key and personal subscription-token credentials. The container includes the pinned SDK runtime. Before planning, local preflight checks each distinct engine/provider connection used by enabled members, excluding globally disabled QA. Failures identify the member and occur before any planning call or worktree creation. Sign-in is permitted with idle recovered Ready tasks; runner activity and executing task states still block credential changes. See [Claude setup and subscription restrictions](SETUP.md#claude).

## API and security

Task retries reuse the same `Idempotency-Key` and submitted input. Defaults resolve only on the first successful submission, so later mode/team changes do not change the task returned by a retry. For new submissions, omitting a mode differs from explicitly selecting it, even when it matches the default; changed input requires a new key. Older request records remain supported, but their fingerprints cannot distinguish an explicit mode from a mode inherited at submission.

The CLI authenticates using `<data-directory>/api-token` (mode `0600`). The service sets the data directory itself to mode `0700` on every start, even if it already existed with wider permissions. Keep this directory private. Only `/health`, the redirect at `/` and the static UI shell under `/ui/` are unauthenticated; every data route needs the bearer token or a browser session (see [Browser UI](#browser-ui)). Bearer requests carrying an `Origin` header are rejected; no CORS is enabled. This is a single-user local service.

Endpoints: `GET/POST /projects`, `GET /agents?projectId=...`, `GET /overview`, `GET /status`, `GET/POST /tasks` (`limit`, `before`, `projectId`, repeatable `state`), `GET /tasks/:id`, `GET /tasks/:id/events?after=`, `GET /tasks/:id/evidence?after=` and `/evidence/:sequence`, `GET /tasks/:id/items`, `POST /tasks/:id/{mode,plan,approve,cancel,run,cleanup}`; browser session routes `POST /ui/bootstrap` (bearer only), `GET /ui/login`, `GET /ui/session`, `POST /ui/logout`. `GET /tasks` returns a page of summaries (id, project, state, version, mode, request excerpt, branch, item count, commit or error) with a `nextBefore` cursor and project-wide state `counts`; `GET /tasks/:id` returns the full record including the plan, agent snapshot and history-derived `approval` status. Evidence text previews are bounded to 16 KB (1 MiB on the single-entry route); truncated entries also carry separately bounded `metadata` for validation/review state and attribution. Task creation requires `Idempotency-Key`; bodies use JSON. Approval includes the reviewed `version`.

Codex still runs inside a verified filesystem sandbox in both modes. The baseline limits tools to the task worktree, temporary storage and (with extra rules off) a dedicated persistent tool HOME, denies secret/runtime paths, Git metadata, external symlinks and hardlinks, isolates the credential store, and disables approval escalation. Command networking is enabled with extra rules off and disabled with them on. Planning and review stay read-only. Unsupported integrations (plugins, browser tools, nested agents and web search) remain unavailable; turning off extra rules does not implement them or import your desktop session's settings. Agent runs load engine exec-policy rules from the dedicated runtime/project context in both modes; extra DevAgents rules add restrictions on top. Standalone validation uses the engine filesystem/network sandbox, not the interactive engine approval workflow. User config is still ignored to keep credentials and integration settings controlled. The worktree is scanned before every launch with streaming directory traversal. With extra rules on, `workspaceScanLimit` (default 200000 entries) bounds the scan. With extra rules off, the entry-count gate is disabled; all entries are still checked for protected paths and unsafe links, and cancellation interrupts the scan. Internal symlinks to non-protected worktree paths are allowed with extra rules off, including package-manager bin links. Hardlinked stores and links outside the worktree remain unsupported.

With extra rules off, validation accepts any well-formed executable/argument list and runs it through the coding engine sandbox. DevAgents does not interpret shell syntax; an explicit shell executable is itself sandboxed. An agent setup phase prepares prerequisites before coding; missing validation tools/dependencies get one separate environment recovery per worktree. Generated/ignored files may be created or modified inside the worktree by implementation and validation; they are not included in the reviewed commit and may affect validation. Source changes during validation still invalidate the result. With extra rules on, validation is restricted to `node --test`, `npm test`, and `npm run test/typecheck/lint/build`, uses a read-only worktree, and implementation may not change ignored files. Both modes keep the 1 MiB validation-output cap, bounded repairs, diff integrity checks and regular-text-only commit limit. With extra rules on, a separate metadata-only preparation sandbox can download locked npm/pnpm dependencies with lifecycle scripts and hooks disabled; agent and validation sandboxes remain offline. With extra rules off, setup scripts/hooks and package-manager version selection are available within the engine sandbox, and dedicated per-worktree HOME/bin and HOME/.local/bin persist on PATH. The managed pnpm wrapper pins absolute store/cache paths outside the checkout in the private worktree runtime (or per-call temporary directory with extra rules on); runtime compaction reclaims these caches. Unignored dependency directories are diagnosed before full change-file enumeration. Ignored dependencies in the original checkout are never copied into managed worktrees. See [environment preparation](SETUP.md#project-environment-preparation) for supported managers and limits.

Git helpers disable hooks/fsmonitor and global/system attributes; worktree creation rejects repository filters. Redaction has two tiers. Model prompts, stored task requests and plans, and API/CLI output remove known secret values (configured provider keys and environment variables whose names look like credentials) plus unmistakable credential tokens (`sk-…`, `ghp_…`, `github_pat_…`) while leaving code such as `token: string` intact, so reviewers and repairing implementers see the real diff. Events, evidence and service logs additionally mask `key=value` assignments, bearer headers and credential-looking object keys, so quoted code in evidence may show `[REDACTED]`. Keep secrets out of task requests. Approval applies to the planned task; the reviewed local commit is an atomic finalization phase, during which cancellation returns a conflict. Interrupted finalization is marked failed for manual inspection and never automatically repeated.

The container is non-root, has a read-only root filesystem, dropped capabilities, resource limits, temporary `/tmp` and a data volume. These service controls alone are not a worker sandbox.

The default two-operation configuration has a 512-process/thread cap, 4 CPUs and 4 GiB of memory. Override these with `DEVAGENTS_PIDS`, `DEVAGENTS_CPUS` and `DEVAGENTS_MEMORY` in `.env`; Docker must have enough resources allocated. The Docker suite runs two Codex protocol workers concurrently under these limits. Raising agent concurrency requires checking container capacity as well as role permissions.

## Validation and contribution

```sh
npm run check
npm run spike:mastra
node scripts/sandbox-spike.mjs  # Requires Codex; no credentials
npm run test:m2                # Single-item fixture with real sandboxed tests/Git
npm run test:m3                # Three-item DAG, dependencies and combined review
node scripts/parallel-smoke.mjs # After build, two top-level tasks with real sandbox validation
npm run test:codex-protocol    # Real runtime/tools against a local model-protocol fixture
npm run test:docker            # Requires Docker; includes M2/M3, parallel tasks, Codex/Claude sandbox fixtures and browser sessions
npm run test:ui                # Browser workflow tests against the labelled development fixture (Playwright, Chromium)
# Only after authenticating the dedicated native profile:
npm run test:codex-live        # Single-item live model fixture
npm run test:m3-live           # Three-item live model fixture; consumes account/API usage
```

Default tests never require paid credentials. The Docker test creates/removes its own unique temporary service, volume and fixture; it does not touch registered projects. Verified on macOS ARM64 and Docker Linux ARM64. AMD64 verification is pending.

Keep contributions focused, add meaningful tests for behavioral/security boundaries, and update the decisions/checklist. Never commit local projects, secrets, login state or task databases. Licensed Apache-2.0.

## Troubleshooting and limits

- Connection refused: start the service; inspect `docker compose logs devagents` if using Docker.
- Missing API token: CLI and server must use the same data directory; run container CLI through `docker compose exec`.
- Missing authentication: run `./devagents start` to unlock the vault and choose a sign-in method. API startup works without credentials.
- Device code sign-in disabled: enable it at https://chatgpt.com/#settings/Security; managed workspaces may require an administrator. Run `./devagents start --auth chatgpt` again. See [official authentication guidance](https://learn.chatgpt.com/docs/auth).
- API quota exceeded: check the API organization’s credits/limits or explicitly switch to ChatGPT sign-in. Replacing a key does not create quota. ChatGPT sign-in has its own Codex allowance and limits.
- Connection test passes but a task fails: the probe checks the saved profile and default model only. Explicit provider environment-key overrides or per-agent models may differ.
- Project registration fails: supply an absolute existing Git root with at least one commit, visible in that environment.
- Invalid agent: check capabilities, duplicate IDs and relative instruction-file paths.
- Task remains `planning` or `ready` after restart: inspect events/evidence, then explicitly queue it with `tasks run TASK_ID`. Interrupted tasks with worktree intent are marked failed; preserved approval waits require approval as usual.
- Leftover worktrees or branches: run `tasks cleanup TASK_ID` for each finished task; use `git worktree list` in the project to see what remains.
- Interrupted work: a service shutdown (`SIGTERM`, `docker compose stop/restart`) marks the running task `failed` with the reason "Service shutdown interrupted execution"; a crash leaves it in its execution state and the next start marks it failed during recovery. Only an explicit `tasks cancel` produces `cancelled`. Mastra persists mode and plan-approval waits and resumes them after the corresponding domain decision. Automatic replay of interrupted execution is not implemented.

For a **live container fixture**, after starting and unlocking the service:

```sh
./devagents start
docker compose exec -T devagents node scripts/m3-smoke.mjs --live
```

It creates and removes only a temporary fixture repository and uses the running container’s unlocked credential profile. It does not register or modify your projects.

The live M3 container fixture passed with ChatGPT sign-in on 2026-10-29 and again on 2026-10-30 at `db95711`: three items, two parallel workers, dependency integration, actual tests, independent item/combined reviews and a final local commit. The original checkout stayed unchanged. Earlier failures led to fixes for the planner schema, Linux write-scope compatibility, container process capacity and review-stage context; see [compatibility findings](M0_FINDINGS.md). Native authenticated and AMD64 execution remain unverified.


## Mastra workflow runtime

### Optional QA gate

Separate agent QA is disabled by default (`qaEnabled: false`). Developer validation and independent code review still run. Use the external pipeline for QA verification; DevAgents does not infer or claim a pipeline pass. When disabled, QA-only roles are excluded from planning and a `qa-assignment` skip records the reason. The existing gate can be explicitly enabled with `qaEnabled: true`. When enabled, the runner selects an enabled `testing` agent from the frozen task roster, independently of the implementers, integrator, and code reviewer. The planner does not need to create a testing work item. A team with no enabled testing agent records `qa-assignment` with `state: skipped`; an enabled QA role that cannot receive the independent assignment fails explicitly.

QA runs after successful validation, on the combined worktree for multi-item tasks, before final code review and the final task commit. It is an engine run with `phase: qa` while the task remains `validating`. Its project permissions are read-only. QA focuses on acceptance criteria and observable behavior, including security behavior; Code Reviewer focuses on implementation, architecture, security controls and test quality. QA may design scenarios and run temporary checks in authorized temporary storage, but does not edit repository tests or implementation during verification. Parallel test preparation is not currently scheduled; adding it requires a separate workflow stage and explicit write ownership. Each required criterion has a stable ID and must receive exactly one `passed`, `failed`, or `blocked` result with evidence. The report and derived decision are persisted as `qa-result`; the final reviewer receives the report for the current diff. Missing or duplicate criteria, malformed output, and source changes during QA cannot pass.

Failed checks use the existing bounded implementation/integration repair budget and require fresh validation and QA. A blocked required criterion stops execution without a final task commit, with the missing prerequisite in the error and evidence; it does not spend code-repair cycles trying to fix the environment. Optional manual checks remain advisory limitations. Cancellation still drains the active run. Historical tasks are never rerun or retroactively marked QA-verified.

### Execution persistence

Run `npm run cli -- scheduler` (or `docker compose exec devagents node dist/cli/main.js scheduler`) to inspect task slots, queued requests, operation counts and recovery attention. The authenticated `GET /scheduler` endpoint returns the same projection. Status/Overview also include scheduler facts; task detail/list responses carry task-specific scheduling reasons. Overview shows all active executions and links to queued history. A task in the `ready` lifecycle state that already owns a scheduler slot is shown as **Preparing execution**, with the actual scheduler reason (including shared operation/preparation waits), rather than as queued.

`maxConcurrentTasks` defaults to 1 and accepts 1–8; `maxConcurrentOperations` defaults to 2 and accepts 1–16. Both startup defaults work in native YAML and through `DEVAGENTS_MAX_CONCURRENT_TASKS` / `DEVAGENTS_MAX_CONCURRENT_OPERATIONS` overrides (restart required). Task capacity can also be changed live with `devagents config task-concurrency 2` or **Settings → Parallel tasks**; omit the CLI argument to inspect it. In Docker use `docker compose exec devagents node dist/cli/main.js config task-concurrency 2`. The saved task limit takes precedence over startup YAML/environment values and survives restarts. Increasing it admits queued tasks on the next scheduler tick; decreasing it never cancels running tasks and admits more only once below the new limit. `GET /settings/task-concurrency` returns `{ maxConcurrentTasks, version }`; authenticated `PUT` accepts `{ maxConcurrentTasks, expectedVersion }`, validates 1–8 and rejects stale versions with 409. Browser writes require the existing session CSRF protection. SQLite schema 6 stores this setting separately from task/team snapshots. The operation limit remains startup-only and bounds actual engine/validation/preparation operations, not whole parent workflows. Per-task work-item and member limits remain in effect. Preparation headroom is reserved across tasks, and Git creation/removal coordinates by the shared repository metadata directory, including registered linked checkouts.

The scheduler preserves one local service owner. Each execution's claim generation is checked in the transaction accepting its task state and evidence. Heartbeats do not authorize automatic takeover. Startup reconciles before admission and does not replay uncertain external effects. Unverified prior worker termination leaves a visible recovery blocker and retains that task's environment; compaction and explicit run requests are refused. General failure resume and distributed workers remain future work.

Task submission and user scheduling decisions also write a SQLite dispatch request in the same transaction. The service claims requests atomically and keeps a newer approval request pending while an older workflow run suspends. The queue survives restart; it does not authorize replaying an interrupted command or commit. One service still owns the local data directory.

Mastra is a production dependency. `devagents-task-v1` runs mode selection, worktree preparation, planning, plan approval, environment preparation and execution. Mastra `dountil` controls implementation/review repair cycles and `foreach` dispatches bounded worker waves. Domain policy still selects dependency-ready workers, enforces per-role limits, validates plans, protects worktrees and requires independent review.

The existing `devagents.db` remains authoritative for tasks, version-checked approvals, frozen teams and evidence. Mastra stores workflow snapshots in `workflows.db` in the same private data directory/volume. Back up the entire data directory with the service stopped. A task's Mastra run ID is its task ID; `workflow-child` evidence links worker-wave and repair-cycle runs. Snapshot inputs and outputs contain only task references and iteration metadata; failures include bounded, redacted error excerpts. Prompts, diffs, full command output and provider settings are not copied into workflow payloads. No Mastra server or Studio endpoint is exposed.

Approval and workflow persistence are separate transactions: the existing API first validates the displayed task version and records approval, then queues the Mastra resume. The workflow checks durable task state again; resume payloads cannot authorize execution. Duplicate enqueue requests do not start another run. An approval received while suspension is being persisted is retained in the queue. Old tasks with no workflow snapshot can enter the workflow at their existing mode/approval boundary without replanning an approved plan.

Mode and plan-approval waits survive restarts. In-flight commands, worker creation and commits are never automatically replayed: normal recovery marks interrupted tasks failed, preserves unfinished work through terminal cleanup snapshots and reconciles unfinished workflow snapshots. Mastra automatic step retries and active-run restart are disabled. `planning`/`ready` tasks with evidence of interrupted work are failed; never-started tasks require an explicit `tasks run TASK_ID` after restart; a framework snapshot showing uncertain prior execution fails closed. Cancellation drains subprocesses and sibling workers before releasing the task slot. General failed-task resume remains a separate feature.

Mastra coordinates existing coding-engine adapters; it does not replace Codex with direct model API calls or change account-login/model-pinning behavior. Project preparation runs through this workflow; the runner dispatches each frozen member to its registered engine adapter.


## Storage recovery and task compaction

`GET /storage` reports available bytes on the task-data filesystem, preparation/runtime headroom, cleanup policy and any halted-execution error. Overview displays available space and warnings. `minFreeDiskBytes` defaults to 5 GiB and controls preparation admission. Each DAG wave budgets that amount per parallel new checkout, reducing parallelism when necessary and failing before setup if even one cannot fit. While executing, a two-second check aborts work below 2 GiB. A service-owned 64 MiB file reserves actual blocks and is released before failure reporting or startup recovery; it is replenished when enough space is available. The monitor is not an OS quota: rapid writes or other containers can still exhaust the filesystem. Persistence failure still halts scheduling rather than claiming recovery succeeded. Disk pressure never waives validation or spends code-repair cycles.

A finished task exposes **Preview task compaction** on its page. The CLI equivalent is:

```sh
devagents tasks compact-preview <task-id>
devagents tasks compact <task-id> --digest <reviewed-digest>
```

The authenticated endpoints are `GET /tasks/:id/compaction-preview` and `POST /tasks/:id/compact` with `{ "digest": "<reviewed-digest>" }`. Browser mutations use the existing CSRF/Host/Origin checks. The server derives paths from managed task/work-item records; client-supplied paths are rejected. Previews expire after ten minutes and after a service restart, bind the task, branch/index state and candidate file metadata (including inode/ctime), and are recomputed before removal. A stale preview requires a fresh one. Scans refuse beyond two million entries, 256 candidates or sixty seconds; Git inventories also have output bounds. Sizes are allocated-byte estimates; they are not a filesystem-exclusive extent measurement.

Compaction targets wholly ignored `node_modules` and `.pnpm-store` directories, each recorded worktree’s private tool HOME under `workspace-runtimes`, and legacy run scratch whose IDs are recorded in that task’s `run-started` evidence. It protects tracked files in HEAD and the index (including staged-only content), skips dependency-root symlinks, never follows internal symlinks, and refuses nested mounts, special files, Git metadata or mismatched worktree registration. Unknown ignored files in worktrees, source, other untracked files, worktree roots, branches, task databases and Mastra snapshots stay intact. Private tool homes and run scratch are disposable environments, including downloaded tools and caches; their internal symlinks are never followed. Unrelated or unowned run directories are left alone. The old `tasks cleanup` command still removes whole worktrees and may discard unfinished changes; compaction is the preserving alternative.

Compaction requires both terminal task state and drained live execution. A per-task maintenance lease excludes run/approve/cancel and other storage actions while scanning/removing. It returns `409 task_active` while workers are draining, rather than waiting while holding the lease. Mastra still controls steps, loops, parallel dispatch, suspension and persistence; hook tracking only establishes that owned processes have finished. The lease excludes service writers, not arbitrary external processes: do not edit the worktree while compacting. Ordinary same-size edits invalidate the preview through file metadata; this is not a content-hash backup or protection against an external process racing deletion.

A `compaction-intent` must persist before any removal. Completion or partial removal is recorded separately; a crash or post-removal persistence error can leave an intent without completion. Inspect the filesystem and obtain a fresh preview before retrying; no source restoration is necessary because compaction does not remove source. If the database is already completely full, the intent write refuses removal. First reclaim separately reviewed obsolete images or other regenerable data to restore database headroom; do not delete the task volume or workflow databases.

Persistence failures no longer replace `SQLITE_FULL` with a failed rollback. If the runner cannot persist its failure/final checkpoint, it drains owned work, halts scheduling, retains task rows and exposes the error through `/storage` while the HTTP service remains available. Recover space and restart the service after inspection. Existing Mastra recovery rules remain: active side effects are not replayed automatically, and a stored `ready` state after a crash does not establish that preparation never ran.

### Automatic resource retention

`cleanupTerminalTasks` defaults to `true` (`DEVAGENTS_CLEANUP_TERMINAL_TASKS` overrides it). Completed, failed and cancelled tasks compact dependencies, private tool homes and owned run scratch after all workers drain, then remove registered task/item worktrees. Startup recovery also visits old terminal tasks. Queued and approval-wait tasks are retained. All task/item branches and commits, task/workflow history and credentials remain. Completed diffs read the retained commits.

A clean checkout is removed normally. Before removing a dirty checkout, cleanup saves a compressed file snapshot, a binary staged patch and a manifest with branch/HEAD/index metadata in a private `recovery/<workspace>-<unique-suffix>/` directory. Unmerged index stages additionally save their raw blobs. Ignored files are private archive contents, never committed. Dependencies were already compacted; remaining generated output is included conservatively. Snapshot admission budgets the remaining uncompressed file sizes, 256 MiB of metadata allowance and the 2 GiB database headroom. Snapshots are verified, flushed to disk and recorded in durable cleanup intent before removal. Path/Git ownership, branch HEAD, index and file metadata are rechecked. Nested Git metadata, mounts, special files, changed files or scan limits defer removal. Cleanup inventory is bounded to 200,000 entries/60 seconds; tar operations to 120 seconds; patches and Git/archive listings to 32 MiB. The lease excludes service writers, not arbitrary external edits.

The Result tab and `worktree-cleanup` evidence show recovery paths. Extract `workspace.tar.gz` into an **empty directory** to inspect the saved working files (deleted files are absent). `manifest.json` identifies the original branch and HEAD. To inspect staged changes separately, create a new worktree at that HEAD and apply `staged.patch` with `git apply --cached`; unmerged stages are described by the manifest index and `conflict-blobs`. Archives can contain private ignored files: keep permissions private. Snapshots have no automatic expiration; remove a snapshot explicitly only after recovering or discarding its work.

If `cleanupTerminalTasks` is disabled, the older `compactCompletedTasks` policy still defaults to `true`: successful tasks compact caches and remove only clean checkouts. Disable both settings (or their `DEVAGENTS_…` environment overrides) to retain every task environment for debugging. The explicit `tasks cleanup` command retains its separate, potentially destructive contract.

Maintenance failures record `compaction-deferred` without changing the task outcome. Missing project mounts, storage errors, ownership changes or scan limits preserve the remaining checkout. Startup retries maintenance. A cleanup intent without completion may indicate a crash after removal; the private recovery directory survives and a subsequent pass safely handles missing checkouts. Setup interrupted in stored `ready` state is now marked failed when environment/non-planning run evidence proves execution began; idle ready tasks are not replayed.

Engine runs and validation commands remove their per-call temporary directories in `finally`, including failure and cancellation. Structured output, validation results and progress remain in task evidence. Private per-worktree tools survive between calls until task compaction. A process/container crash can leave scratch behind; terminal-task recovery handles run directories with recorded ownership. Historical validation directories have no task ownership record and are not swept automatically.

After a successful launcher rebuild, the launcher removes only the superseded DevAgents image if it has no tags and no container references. Other Docker images/build cache and unrelated containers/volumes live outside the task retention policy. Use `docker system df` to inspect them. Reclaim obsolete build images/cache separately; do not delete the task-data volume, credential vault, result branches or workflow databases. The 5 GiB per-checkout admission budget and 2 GiB runtime guard remain: cleanup limits accumulation but cannot guarantee capacity against a large active task or other Docker workloads.

### Slow Git scans on mounted repositories

Before multi-item execution and at item/combined review, DevAgents checks the original checkout with full tracked/untracked Git status. These read-only scans allow 120 seconds and retry once only after a timeout. Optional Git index writes are disabled for the scans; ignore rules and untracked-file coverage are unchanged. A retry is recorded in Activity. Cancellation stops the active scan and prevents another attempt; real Git errors and output-limit failures are not retried. Both attempts failing stops the task with a concrete timeout message rather than bypassing checkout verification. Other Git operations retain their 30-second default and now also identify timeout failures explicitly.

If this persists, check the Docker bind mount and host filesystem responsiveness. A failed task remains in history; submit a new task after resolving the issue. DevAgents does not automatically replay paid agent work.


### Offline Claude verification

`npm run build && node scripts/claude-sandbox-smoke.mjs` uses synthetic credentials and mocked inference with the real SDK MCP server and OS sandbox. It checks installed runtimes, file reads/writes, read-only review, credential-free command environments and preservation of an outside sentinel. It requires the pinned Codex CLI on PATH. In Docker: `docker run --rm --read-only --network none --cap-drop ALL --security-opt no-new-privileges:true --tmpfs /tmp:rw,mode=1777,size=256m devagents:local node scripts/claude-sandbox-smoke.mjs`. This fixture makes no model request and cannot establish account access or model quality.

### Private process information and validation timeouts

Docker Compose uses `security_opt: systempaths=unconfined` so the engine can
mount fresh procfs inside its private PID/user namespace. Without it, Node
`process.memoryUsage()` fails and Vitest workers can hang after tests pass.
The engine sandbox remains enforced; do not grant filesystem access to the
outer container's `/proc`. Read-only root, dropped capabilities and
no-new-privileges remain enabled. Recreate existing containers after updating.

Execution workflow shows each running validation command, elapsed time and its
timeout limit. Timed-out checks retain bounded partial output in Activity and
stop with an explicit validation timeout instead of spending a repair attempt.
The deterministic `scripts/proc-sandbox-smoke.mjs` checks worker completion and
isolation from outer process environment and root.
