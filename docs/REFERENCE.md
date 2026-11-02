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
docker compose exec devagents node dist/cli/main.js projects add my-project /projects/my-project
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
npm run cli -- projects add my-project /absolute/path/to/existing-checkout
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

Reuse `--key` with identical input to retry submission without duplication. Use `tasks show` to find the managed branch, worktree path and final commit. The managed branch is named after the request and the task: `devagents/<slug>-<first eight characters of the task id>`, for example `devagents/fix-my-orders-12b1ca2d`; work items use `<task branch>-<item id>`. Branches created by earlier versions (`codex/devagents-<task id>`) stay recognised for diffs and cleanup. The final commit's subject is the first line of the request. One top-level request runs at a time. Within it, ready items run in deterministic waves bounded by global `concurrency` and each role’s `concurrency`. Integration is serial and dependent items start only after prior waves are integrated. Nothing is pushed or merged into the original checkout automatically.

## Browser UI

The service serves the built UI on its own port at `http://127.0.0.1:4310/ui/`; `/` redirects there. Nothing else needs to run. Sign in with a one-time link created through the CLI, which is the only path that holds the long-lived API token:

```sh
npm run cli -- ui            # prints a single-use link valid for 10 minutes; add --open to launch a browser
docker compose exec devagents node dist/cli/main.js ui   # same inside the container
```

In Docker the link carries the published host port (`DEVAGENTS_PORT`, passed to the container as `DEVAGENTS_PUBLIC_PORT`), not the internal 4310. The link sets an `HttpOnly; SameSite=Strict` session cookie. Sessions end on sign-out, after 12 hours idle, 24 hours in total, or whenever the service restarts; mint a new link then. The API token itself is never sent to the browser and authentication and provider secrets are never stored in browser storage. U3 keeps an unresolved submission key and its exact task-input payload in tab-scoped `sessionStorage` so retries survive reload and session renewal; do not include secrets in task requests or acceptance criteria.

What U1 shows, all from real service data: an overview with attention items (mode choice, plan approval), the running task with its work items, measured counts and recent outcomes; a filterable, paged task list; a task page with header, plain-language status, work items with stages derived from evidence (implementation runs, test results, review outcome, checkpoints, repairs), the frozen plan, chronological activity with bounded evidence previews, and the result (commit, branch, files, review). Settings reports connection availability without secrets; a saved sign-in is never presented as verified model access. U3 enables registration, submission, mode choice, approval, cancellation, diff inspection and guided setup. Browser cleanup remains disabled until a preview/ownership contract is implemented.

### Saved teams (U2)

Service startup installs an editable **Starter team** with Tech Lead, Developer, QA Engineer and independent Code Reviewer. Ready, active starter teams are selected for new projects automatically. Existing untouched projects receive it on upgrade; custom defaults, explicitly cleared defaults, team edits and archives survive restart. Task snapshots retain their original revisions.

A team is a saved, named roster: an explicit copy of registry templates and custom roles, stored in SQLite with append-only revisions, never written back to YAML. The Teams page lists active and archived teams with the server's readiness verdict; the editor adds members from a template (copied, not linked) or as a custom role, with labelled fields for name, description, instructions, worker/planner role, engine, provider, model override, capabilities, read/write scope, sandboxed commands and concurrency. Engines, providers and capabilities that this build cannot execute are disabled with the reason; a team whose members name them, or that lacks a planner, a writable implementer or a reviewer distinct from that implementer (the same rule plan validation applies; review itself always runs read-only), saves as a **draft** with per-member diagnostics and cannot receive work. Malformed or forbidden members (path traversal, absolute paths, unsupported glob forms, push) are refused outright. Readiness never consults sign-in or model access; those are verified only by an actual run.

Every save creates a new revision; a save or archive against an older revision is refused with 409 and the browser keeps your input, offering to reload the newer revision or save your edits explicitly on top of it. Duplicate makes an independent copy. Archived teams cannot be edited or chosen for new tasks. A project card sets or clears the project's default team under the project's settings version.

Submission freezes the team: `tasks submit --team <id>` (or `teamId` on `POST /tasks`), otherwise the project default, otherwise the legacy registry. The chosen revision, every member's instructions and permissions, and the concrete engine, provider and provider configuration (never credential values) are copied into the task inside the creation transaction, after the idempotency check, so a retried submission returns the original task even after the team changed. The runner reads only that snapshot: editing, archiving or reconfiguring afterwards cannot change queued, awaiting, running or recovering work. An archived default team fails submission with an actionable error rather than falling back silently. Plan validation remains a separate gate: a plan that assigns an agent outside the team fails before any worker starts. Old tasks and tasks without a team show "Legacy agent configuration"; their agents are snapshotted when the worktree is created, as before.

`model: default` is not a pinned model: the Codex runtime chooses at execution. Set `defaultModel` in `devagents.yaml` (or a member's model override) to pin team snapshots; without it the task records `modelPinned: false` and the UI says so. DevAgents never guesses a model ID or makes a discovery call.

CLI: `teams list [--archived|--all]`, `teams templates`, `teams show <id>`, `teams check <file>`, `teams create <file>`, `teams edit <id> <file> --revision N`, `teams archive|restore <id> --revision N`, `teams duplicate <id> <name>`, `projects default-team <project> <team-id|none> --version N`. Team files are YAML or JSON with `name`, `description` and `members` (bounded: 12 members, 64,000 characters of instructions per member and 192,000 bytes in total; template copies are complete, and a roster over the budget is refused with the total stated, never trimmed).

Overview queries active work and attention items independently of recent history. Attention previews show up to 50 tasks and link to the full filtered list. Task state filters apply before pagination; counts cover the selected project across all pages. Request-text search is explicitly limited to the displayed page. Plan approval labels come from persisted approval events, so rejecting a plan never presents it as approved. Large evidence previews retain validation exit/truncation status and review findings counts separately from their text.

Progress updates use bounded polling with exponential backoff. When the service is unreachable the UI shows a disconnected banner with the last update time and keeps the last known state; nothing is invented, and on reconnect history is reconciled by sequence cursor so nothing is duplicated or lost.

Security contract: the UI and API share one origin; every response carries a strict Content Security Policy (`script-src 'self'`, no remote fonts, images or connections), `X-Frame-Options: DENY` and `nosniff`. Cookie sessions are accepted only with a loopback `Host` on the listening port and a same-origin `Origin`/`Sec-Fetch-Site`, so another localhost port or a DNS-rebinding page is refused; state-changing requests additionally need the session's CSRF token. Model text, logs, plans and evidence are rendered as text only: no Markdown, no HTML, no generated links or images. The CLI bearer path is unchanged and still refuses any request carrying an `Origin` header.

Development: `npm run dev:ui` starts a Vite dev server on `127.0.0.1:5173` that proxies API calls to a running service; sign in once through the service's link so the cookie exists. `npm run test:ui` runs the Playwright browser tests against `scripts/ui-fixture.mjs`, a clearly labelled development fixture with a deterministic fake engine on a temporary data directory (run `npx playwright install chromium` once). Browser tests generate representative screenshots in ignored `test-results/ui-screenshots/`; set `DEVAGENTS_UI_SCREENSHOT_DIR` to choose another output directory.

Known limits: Claude and non-OpenAI providers can be saved only as drafts until M4; the design's Plus Jakarta Sans is not bundled, so the UI uses the system font stack; evidence text previews are capped at 16 KB with a 1 MiB single-entry fetch, accompanied by separately bounded status metadata; updates use polling rather than streaming. Work-item cards show dependencies; there is no graphical dependency editor.

### Browser workflows (U3)

1. Open **Projects → Register repository** (`/ui/projects/new`). Supply an existing Git checkout's absolute path as seen by the service. In Docker, mount the checkout and register its container path; the browser does not clone repositories or mount host folders. Refusals preserve your input and show the service's error.
2. Open **Submit task** (`/ui/tasks/new`). Choose a project, enter the request and acceptance criteria, then choose a ready team or inherit the project default. Drafts and archived teams remain visible with reasons but cannot be selected. A configured project default cannot be bypassed with a legacy-team option. The form shows effective project/service mode defaults; when none exists, the task waits for a mode choice. The accepted panel reports the actual frozen team revision returned by the service.
3. The browser saves one key and exact payload per attempt before sending. Duplicate clicks and edits are blocked while pending or unresolved. A dropped response or 30-second request timeout offers a same-key retry; reload, session renewal and service restart preserve that identity. Other mutations are never replayed automatically. Explicit abandonment warns that the first task may already exist. Confirmed success clears the attempt; **Submit another task** deliberately starts fresh. Closing the tab loses this recovery state.
4. On a task, choose a mode if required. Approval in the header or Plan tab binds to the displayed version; a 409 refreshes the plan and requires a fresh decision. Rejection cancels the task, preserving worktrees. Queued/running tasks can be cancelled; committing cannot. Resubmission from a failed/cancelled task copies only request text and acceptance criteria, with fresh project/team/mode choices and a new key.
5. Completed results offer **Read-only diff**. `GET /tasks/:id/diff` accepts task identity only, verifies the registered repository, task-owned worktree path/branch and recorded base/final commit objects, and disables Git external diff/textconv helpers. Missing or mismatched metadata is unavailable, never an empty diff. Retained completed branches remain inspectable after CLI cleanup if the commits and ownership metadata still exist.

Diff display caps are **64 KiB per file, 256 KiB total text, 200 files**, plus a 256 KiB file-list bound and a **1 MiB per-file read bound** and **4 MiB aggregate patch-read budget per request**. Overflowing reads consume their reserved budget even when no text is displayed; subsequent files are marked truncated once it is exhausted. Known secret values are redacted before display truncation. Files exceeding the read bound have their entire text omitted; protected credential-file content is withheld, and binary content is not displayed. File-list overflow returns an explicit unavailable error. Empty, binary, withheld, truncated, unavailable and not-offered states are distinct. There is no patch download, browser cleanup or live/failed-task diff.

**Settings → Guided setup** (`/ui/settings/setup`) separates the browser session, runtime, saved sign-in, model-access verification, project and team. Provider connection is available in the browser or terminal. The host launcher handles project mounts; recovery commands can be copied into your terminal. The setup page accepts a new API key only in a password field and sends it to the local service; it cannot read saved credentials. No paid connection test runs automatically. Submission remains available without a saved sign-in, with a preflight warning. Model pinning and frozen-team semantics are unchanged.

## Multi-agent plans and progress

The Tech Lead chooses up to 30 work items with assigned agents, dependencies, validation commands, managed branches and `ownedPaths`. Each item needs a writable implementer with the required capabilities, and review must be independent of all implementers and the integrator. Multi-item plans need combined validation; single-item plans use item validation and `integration: null`. Planning and execution use the task's frozen policy. With extra rules off (the default), owned paths describe the planned scope; the engine can write elsewhere within its isolated worktree. With extra rules on, owned paths are enforced, may only narrow role permissions, and Linux write grants must be directory subtrees such as `project:/src/component/**`. Unsupported plans are refused before approval.

Use `tasks show TASK_ID` to inspect and approve the plan, `tasks items TASK_ID` for each item’s progress/worktree/commit, and `tasks evidence TASK_ID` for runs, validation, checkpoints and integration decisions. A plan-approval wait stops all implementation workers. For parallel work by one role, set that role’s `concurrency` above 1; different roles can run concurrently at their existing limits.

Each worker branches from a private snapshot of results already integrated into the task worktree. Successful item validation and independent review produce a private work-item commit. These commits and dependency checkpoints are intermediate evidence, not final task approval. Changes are combined with three-way patch application in the task worktree. Conflicts become an explicit integration-agent repair bounded by `maxRepairCycles`. A repair counts as resolved only when the file content is clean: any `<<<<<<<`, `|||||||` or `>>>>>>>` line fails it, and a bare `=======` line fails it when the file has more of them than either side had before the merge, so Markdown heading underlines are allowed while leftover dividers are not; Git must also report no unmerged entry. Unresolved conflicts stop the task and preserve its worktrees. Repository-defined filters and custom merge drivers are refused.

After integration, all item checks and the combined checks run again. A reviewer distinct from all implementers and the integration agent must approve the complete diff before one final commit is created on the task branch. Per-item repair budgets and a separate shared integration repair budget are bounded. Cancellation or failure drains sibling workers and blocks unstarted dependents; item evidence records why each worker stopped (`failed`, `aborted` by a sibling failure, `cancelled` by the user, or `interrupted` by a service shutdown). A private checkpoint may already exist when cancellation arrives; a cancelled task never advances to the final combined commit. Restart recovery preserves paths/evidence and marks interrupted tasks failed rather than replaying them automatically. Nothing is cleaned up automatically: a finished task leaves its task worktree, item worktrees and item branches in place until you run `tasks cleanup TASK_ID`, which removes only worktrees registered under the data directory for that task and only branches named `codex/devagents-<task-id>…`, keeps a completed task’s branch (the reviewed commit), and records what it removed as evidence. It refuses active tasks and anything it cannot prove it created.

## Configuration and agents

### Optional extra rules

`devagentsRules: false` is the default for new tasks. Set `devagentsRules: true` in the service YAML configuration to add DevAgents' command allowlist, role read/write/shell restrictions, per-item write scopes, read-only validation, ignored-file mutation checks and blanket symlink denials. Environment variable `DEVAGENTS_RULES=true|false` overrides YAML; invalid values stop startup. Docker Compose supplies `false` by default. For persistent Docker configuration, set `DEVAGENTS_RULES=true` in the repository's `.env`, then run `./devagents start`.

The flag is frozen transactionally at task submission, after idempotency lookup, and recorded in run evidence. Existing tasks without a flag retain their original strict behavior; retrying the same submission key never changes it. Settings shows the service default and the task page shows the frozen value. Submit a new task to use a new default. No browser or model-provided task input can override it.

This is an extra-policy toggle, not an unrestricted execution switch: worktree and credential boundaries, no automatic pushes/merges/deployments, task/plan integrity, real validation, independent review, resource limits and browser authentication remain mandatory. Engine-denied operations still fail; there is no unsandboxed fallback. Only Codex is executable today; Claude support remains M4.

`DEVAGENTS_DATA_DIR` defaults to `.devagents`, and `DEVAGENTS_PORT` to `4310`. Set `DEVAGENTS_CONFIG` to a YAML file such as `examples/devagents.yaml`. The default OpenAI provider uses the saved Codex profile (including a saved API key); an explicitly configured `auth: api-key` with `apiKeyEnv` instead selects the existing environment-variable flow. The native process does not automatically load `.env`; `.env.example` documents variables. Compose uses `.env` for substitution only.

Six built-ins: Tech Lead, Developer, Backend Developer, Frontend Developer, QA Engineer and Code Reviewer. Add YAML and Markdown under `<data-directory>/agents/` or `<project>/.devagents/agents/`. Precedence is project > user > bundled `agents/builtin/`. Duplicate IDs within a directory fail validation. Definitions reload when the registry is requested and are snapshotted when a legacy task creates its worktree; saved teams copy them at edit time instead (see [Saved teams](#saved-teams-u2)). `defaultModel` optionally pins the model recorded in team snapshots.

```yaml
schemaVersion: 1
id: technical-writer
name: Technical Writer
description: Writes and reviews project documentation
engine: codex
provider: openai
model: default
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

Anthropic API-key configuration is represented; its adapter is planned for M4. Third-party Claude subscription login needs an officially permitted integration, as explained in [M0 findings](M0_FINDINGS.md). The container does not include Claude.

## API and security

Task retries reuse the same `Idempotency-Key` and submitted input. Defaults resolve only on the first successful submission, so later mode/team changes do not change the task returned by a retry. For new submissions, omitting a mode differs from explicitly selecting it, even when it matches the default; changed input requires a new key. Older request records remain supported, but their fingerprints cannot distinguish an explicit mode from a mode inherited at submission.

The CLI authenticates using `<data-directory>/api-token` (mode `0600`). The service sets the data directory itself to mode `0700` on every start, even if it already existed with wider permissions. Keep this directory private. Only `/health`, the redirect at `/` and the static UI shell under `/ui/` are unauthenticated; every data route needs the bearer token or a browser session (see [Browser UI](#browser-ui)). Bearer requests carrying an `Origin` header are rejected; no CORS is enabled. This is a single-user local service.

Endpoints: `GET/POST /projects`, `GET /agents?projectId=...`, `GET /overview`, `GET /status`, `GET/POST /tasks` (`limit`, `before`, `projectId`, repeatable `state`), `GET /tasks/:id`, `GET /tasks/:id/events?after=`, `GET /tasks/:id/evidence?after=` and `/evidence/:sequence`, `GET /tasks/:id/items`, `POST /tasks/:id/{mode,plan,approve,cancel,run,cleanup}`; browser session routes `POST /ui/bootstrap` (bearer only), `GET /ui/login`, `GET /ui/session`, `POST /ui/logout`. `GET /tasks` returns a page of summaries (id, project, state, version, mode, request excerpt, branch, item count, commit or error) with a `nextBefore` cursor and project-wide state `counts`; `GET /tasks/:id` returns the full record including the plan, agent snapshot and history-derived `approval` status. Evidence text previews are bounded to 16 KB (1 MiB on the single-entry route); truncated entries also carry separately bounded `metadata` for validation/review state and attribution. Task creation requires `Idempotency-Key`; bodies use JSON. Approval includes the reviewed `version`.

Codex still runs inside a verified filesystem sandbox in both modes. The baseline limits tools to the task worktree, temporary storage and (with extra rules off) a dedicated persistent tool HOME, denies secret/runtime paths, Git metadata, external symlinks and hardlinks, isolates the credential store, and disables approval escalation. Command networking is enabled with extra rules off and disabled with them on. Planning and review stay read-only. Unsupported integrations (plugins, browser tools, nested agents and web search) remain unavailable; turning off extra rules does not implement them or import your desktop session's settings. Agent runs load engine exec-policy rules from the dedicated runtime/project context in both modes; extra DevAgents rules add restrictions on top. Standalone validation uses the engine filesystem/network sandbox, not the interactive engine approval workflow. User config is still ignored to keep credentials and integration settings controlled. The worktree is scanned before every launch with streaming directory traversal. With extra rules on, `workspaceScanLimit` (default 200000 entries) bounds the scan. With extra rules off, the entry-count gate is disabled; all entries are still checked for protected paths and unsafe links, and cancellation interrupts the scan. Internal symlinks to non-protected worktree paths are allowed with extra rules off, including package-manager bin links. Hardlinked stores and links outside the worktree remain unsupported.

With extra rules off, validation accepts any well-formed executable/argument list and runs it through the coding engine sandbox. DevAgents does not interpret shell syntax; an explicit shell executable is itself sandboxed. An agent setup phase prepares prerequisites before coding; missing validation tools/dependencies get one separate environment recovery per worktree. Generated/ignored files may be created or modified inside the worktree by implementation and validation; they are not included in the reviewed commit and may affect validation. Source changes during validation still invalidate the result. With extra rules on, validation is restricted to `node --test`, `npm test`, and `npm run test/typecheck/lint/build`, uses a read-only worktree, and implementation may not change ignored files. Both modes keep the 1 MiB validation-output cap, bounded repairs, diff integrity checks and regular-text-only commit limit. With extra rules on, a separate metadata-only preparation sandbox can download locked npm/pnpm dependencies with lifecycle scripts and hooks disabled; agent and validation sandboxes remain offline. With extra rules off, setup scripts/hooks and package-manager version selection are available within the engine sandbox, and dedicated per-worktree HOME/bin and HOME/.local/bin persist on PATH. Ignored dependencies in the original checkout are never copied into managed worktrees. See [environment preparation](SETUP.md#project-environment-preparation) for supported managers and limits.

Git helpers disable hooks/fsmonitor and global/system attributes; worktree creation rejects repository filters. Redaction has two tiers. Model prompts, stored task requests and plans, and API/CLI output remove known secret values (configured provider keys and environment variables whose names look like credentials) plus unmistakable credential tokens (`sk-…`, `ghp_…`, `github_pat_…`) while leaving code such as `token: string` intact, so reviewers and repairing implementers see the real diff. Events, evidence and service logs additionally mask `key=value` assignments, bearer headers and credential-looking object keys, so quoted code in evidence may show `[REDACTED]`. Keep secrets out of task requests. Approval applies to the planned task; the reviewed local commit is an atomic finalization phase, during which cancellation returns a conflict. Interrupted finalization is marked failed for manual inspection and never automatically repeated.

The container is non-root, has a read-only root filesystem, dropped capabilities, resource limits, temporary `/tmp` and a data volume. These service controls alone are not a worker sandbox.

The default two-worker configuration has a 512-process/thread cap, 4 CPUs and 4 GiB of memory. Override these with `DEVAGENTS_PIDS`, `DEVAGENTS_CPUS` and `DEVAGENTS_MEMORY` in `.env`; Docker must have enough resources allocated. The Docker suite runs two Codex protocol workers concurrently under these limits. Raising agent concurrency requires checking container capacity as well as role permissions.

## Validation and contribution

```sh
npm run check
npm run spike:mastra
node scripts/sandbox-spike.mjs  # Requires Codex; no credentials
npm run test:m2                # Single-item fixture with real sandboxed tests/Git
npm run test:m3                # Three-item DAG, dependencies and combined review
npm run test:codex-protocol    # Real runtime/tools against a local model-protocol fixture
npm run test:docker            # Requires Docker; includes M2, M3, runtime fixtures and the browser UI session exchange
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

Mastra is a production dependency. `devagents-task-v1` runs mode selection, worktree preparation, planning, plan approval, environment preparation and execution. Mastra `dountil` controls implementation/review repair cycles and `foreach` dispatches bounded worker waves. Domain policy still selects dependency-ready workers, enforces per-role limits, validates plans, protects worktrees and requires independent review.

The existing `devagents.db` remains authoritative for tasks, version-checked approvals, frozen teams and evidence. Mastra stores workflow snapshots in `workflows.db` in the same private data directory/volume. Back up the entire data directory with the service stopped. A task's Mastra run ID is its task ID; `workflow-child` evidence links worker-wave and repair-cycle runs. Snapshot inputs and outputs contain only task references and iteration metadata; failures include bounded, redacted error excerpts. Prompts, diffs, full command output and provider settings are not copied into workflow payloads. No Mastra server or Studio endpoint is exposed.

Approval and workflow persistence are separate transactions: the existing API first validates the displayed task version and records approval, then queues the Mastra resume. The workflow checks durable task state again; resume payloads cannot authorize execution. Duplicate enqueue requests do not start another run. An approval received while suspension is being persisted is retained in the queue. Old tasks with no workflow snapshot can enter the workflow at their existing mode/approval boundary without replanning an approved plan.

Mode and plan-approval waits survive restarts. In-flight commands, worker creation and commits are never automatically replayed: normal recovery marks interrupted tasks failed, preserves worktrees and reconciles unfinished workflow snapshots. Mastra automatic step retries and active-run restart are disabled. `planning`/`ready` tasks still require an explicit `tasks run TASK_ID` after restart; a framework snapshot showing uncertain prior execution fails closed. Cancellation drains subprocesses and sibling workers before releasing the task slot. General failed-task resume remains a separate feature.

Mastra coordinates existing coding-engine adapters; it does not replace Codex with direct model API calls or change account-login/model-pinning behavior. Project preparation runs through this workflow; the Claude adapter remains separate work.
