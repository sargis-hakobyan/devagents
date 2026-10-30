# DevAgents

DevAgents is an open-source, local-first AI development-team orchestrator, being built to plan, delegate, implement, test and review changes with configurable agents and replaceable coding engines.

**Current status: M3 multi-agent execution implemented and live container acceptance verified with ChatGPT sign-in.** A dynamic Tech Lead plans a task DAG and selects configured specialists. Independent items run in isolated worktrees with bounded concurrency; dependency results are integrated before downstream work starts. Real sandboxed checks and independent item/combined review gate the final local commit. Approval waits, bounded repairs, cancellation and execution evidence are persisted. Native and Docker checks are documented in [milestones](docs/MILESTONES.md), [compatibility findings](docs/M0_FINDINGS.md), and [decisions](docs/DECISIONS.md).

A local **browser UI** is being delivered in three increments. **U1 (visibility) and U2 (saved teams) are implemented**: a same-origin dashboard served by the service itself with a protected browser session, read-only overview, tasks, task detail with measured progress and evidence, projects and settings, plus saved teams with a member editor, revisions, readiness diagnostics and project default teams. U3 (browser task workflows and guided setup) follows; its controls are shown disabled with the CLI alternative. See [Browser UI](#browser-ui), the [frontend brief](docs/FRONTEND_BRIEF.md), the [implementation plan](docs/UI_IMPLEMENTATION_PLAN.md) and the [design boards](design/ui/README.md). The authorized post-review M2/M3 live reruns passed on 2026-10-30 at `db95711` using the saved ChatGPT account in Docker Linux ARM64. Claude owns the next U2 implementation; its handoff is in the existing implementation plan.

## Docker quickstart

```sh
./devagents start
```

The launcher builds and starts Docker, unlocks encrypted credentials, and offers **ChatGPT account**, **OpenAI API key**, or **Continue with saved login** (Enter on later starts). ChatGPT sign-in uses your plan’s Codex allowance; API keys use separate API billing. Keys are entered at a hidden prompt. For ChatGPT, the wizard explains device-code enablement and the official runtime prints the login link and one-time code. No host Node.js is required. The initial build downloads dependencies and Codex. The API is at `127.0.0.1:4310`; `/health` reports readiness. The `devagents-data` volume persists state. Home directories and the Docker socket are not mounted.

For an already-cloned project, copy `examples/compose.project.yaml` to `compose.override.yaml`, set the absolute source path, then:

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

Noninteractive starts reuse saved credentials and skip the test unless explicitly requested; missing credentials fail with instructions to use a terminal. A failed connection check exits nonzero while keeping the service and saved credentials available. No automatic switch between billing methods occurs. Ctrl+C cancels setup or the running connection test.

Credentials are encrypted with AES-256-GCM in `/data/credentials/codex.enc` inside the persistent Docker volume. The separate random encryption key lives in **macOS Keychain** (or a Linux desktop Secret Service via `secret-tool`). The launcher retrieves it automatically; a locked OS keychain may require your normal OS unlock. No encryption key is stored beside the encrypted file.

Codex’s decrypted credential file and the encryption key exist only in the container’s private `/run/devagents-auth` tmpfs while it runs. Restarting clears that memory-backed directory; `./devagents start` unlocks it again. Existing Docker `auth.json` credentials migrate automatically: encryption is verified and saved before the old plaintext file is removed. Existing backups/snapshots are not erased by migration.

The API key is never added to project configuration, shell history or the image. Keep both the persistent volume and the OS keychain entry to retain credentials. The keychain entry is scoped to this checkout’s absolute path; moving the checkout or restoring it on another machine requires restoring the matching keychain entry. If that entry is missing while an encrypted vault exists, startup fails without overwriting credentials. Both ChatGPT and API-key logins can be reused or changed through the menu. Credential storage does not confirm API credit balance or model access.

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

Reuse `--key` with identical input to retry submission without duplication. Use `tasks show` to find the managed branch, worktree path and final commit. One top-level request runs at a time. Within it, ready items run in deterministic waves bounded by global `concurrency` and each role’s `concurrency`. Integration is serial and dependent items start only after prior waves are integrated. Nothing is pushed or merged into the original checkout automatically.

## Browser UI

The service serves the built UI on its own port at `http://127.0.0.1:4310/ui/`; `/` redirects there. Nothing else needs to run. Sign in with a one-time link created through the CLI, which is the only path that holds the long-lived API token:

```sh
npm run cli -- ui            # prints a single-use link valid for 10 minutes; add --open to launch a browser
docker compose exec devagents node dist/cli/main.js ui   # same inside the container
```

In Docker the link carries the published host port (`DEVAGENTS_PORT`, passed to the container as `DEVAGENTS_PUBLIC_PORT`), not the internal 4310. The link sets an `HttpOnly; SameSite=Strict` session cookie. Sessions end on sign-out, after 12 hours idle, 24 hours in total, or whenever the service restarts; mint a new link then. The API token itself is never sent to the browser and the UI stores nothing in browser storage.

What U1 shows, all from real service data: an overview with attention items (mode choice, plan approval), the running task with its work items, measured counts and recent outcomes; a filterable, paged task list; a task page with header, plain-language status, work items with stages derived from evidence (implementation runs, test results, review outcome, checkpoints, repairs), the frozen plan, chronological activity with bounded evidence previews, and the result (commit, branch, files, review). Settings reports connection availability without secrets; a saved sign-in is never presented as verified model access. Controls for later increments (submit, approve, cancel, register, cleanup, guided setup) are visible but disabled, each with its CLI alternative.

### Saved teams (U2)

A team is a saved, named roster: an explicit copy of registry templates and custom roles, stored in SQLite with append-only revisions, never written back to YAML. The Teams page lists active and archived teams with the server's readiness verdict; the editor adds members from a template (copied, not linked) or as a custom role, with labelled fields for name, description, instructions, worker/planner role, engine, provider, model override, capabilities, read/write scope, sandboxed commands and concurrency. Engines, providers and capabilities that this build cannot execute are disabled with the reason; a team whose members name them, or that lacks a planner, a writable implementer or a reviewer distinct from that implementer (the same rule plan validation applies; review itself always runs read-only), saves as a **draft** with per-member diagnostics and cannot receive work. Malformed or forbidden members (path traversal, absolute paths, unsupported glob forms, push) are refused outright. Readiness never consults sign-in or model access; those are verified only by an actual run.

Every save creates a new revision; a save or archive against an older revision is refused with 409 and the browser keeps your input, offering to reload the newer revision or save your edits explicitly on top of it. Duplicate makes an independent copy. Archived teams cannot be edited or chosen for new tasks. A project card sets or clears the project's default team under the project's settings version.

Submission freezes the team: `tasks submit --team <id>` (or `teamId` on `POST /tasks`), otherwise the project default, otherwise the legacy registry. The chosen revision, every member's instructions and permissions, and the concrete engine, provider and provider configuration (never credential values) are copied into the task inside the creation transaction, after the idempotency check, so a retried submission returns the original task even after the team changed. The runner reads only that snapshot: editing, archiving or reconfiguring afterwards cannot change queued, awaiting, running or recovering work. An archived default team fails submission with an actionable error rather than falling back silently. Plan validation remains a separate gate: a plan that assigns an agent outside the team fails before any worker starts. Old tasks and tasks without a team show "Legacy agent configuration"; their agents are snapshotted when the worktree is created, as before.

`model: default` is not a pinned model: the Codex runtime chooses at execution. Set `defaultModel` in `devagents.yaml` (or a member's model override) to pin team snapshots; without it the task records `modelPinned: false` and the UI says so. DevAgents never guesses a model ID or makes a discovery call.

CLI: `teams list [--archived|--all]`, `teams templates`, `teams show <id>`, `teams check <file>`, `teams create <file>`, `teams edit <id> <file> --revision N`, `teams archive|restore <id> --revision N`, `teams duplicate <id> <name>`, `projects default-team <project> <team-id|none> --version N`. Team files are YAML or JSON with `name`, `description` and `members` (bounded: 12 members, 64,000 characters of instructions per member and 192,000 bytes in total; template copies are complete, and a roster over the budget is refused with the total stated, never trimmed).

Overview queries active work and attention items independently of recent history. Attention previews show up to 50 tasks and link to the full filtered list. Task state filters apply before pagination; counts cover the selected project across all pages. Request-text search is explicitly limited to the displayed page. Plan approval labels come from persisted approval events, so rejecting a plan never presents it as approved. Large evidence previews retain validation exit/truncation status and review findings counts separately from their text.

Progress updates use bounded polling with exponential backoff. When the service is unreachable the UI shows a disconnected banner with the last update time and keeps the last known state; nothing is invented, and on reconnect history is reconciled by sequence cursor so nothing is duplicated or lost.

Security contract: the UI and API share one origin; every response carries a strict Content Security Policy (`script-src 'self'`, no remote fonts, images or connections), `X-Frame-Options: DENY` and `nosniff`. Cookie sessions are accepted only with a loopback `Host` on the listening port and a same-origin `Origin`/`Sec-Fetch-Site`, so another localhost port or a DNS-rebinding page is refused; state-changing requests additionally need the session's CSRF token. Model text, logs, plans and evidence are rendered as text only: no Markdown, no HTML, no generated links or images. The CLI bearer path is unchanged and still refuses any request carrying an `Origin` header.

Development: `npm run dev:ui` starts a Vite dev server on `127.0.0.1:5173` that proxies API calls to a running service; sign in once through the service's link so the cookie exists. `npm run test:ui` runs the Playwright browser tests against `scripts/ui-fixture.mjs`, a clearly labelled development fixture with a deterministic fake engine on a temporary data directory (run `npx playwright install chromium` once). Browser tests generate representative screenshots in ignored `test-results/ui-screenshots/`; set `DEVAGENTS_UI_SCREENSHOT_DIR` to choose another output directory.

Known U1/U2 limits: a team is read-only configuration until U3 adds browser submission, so choosing a team for a task is CLI/API only; the Claude engine and non-OpenAI providers can be saved only as drafts until M4; the design's Plus Jakarta Sans is not bundled, so the UI uses the system font stack; evidence text previews are capped at 16 KB with a 1 MiB single-entry fetch, accompanied by separately bounded status metadata; there is no event streaming, only polling; path access diagnostics for projects and the dependency graph view arrive with U3.

## Multi-agent plans and progress

The Tech Lead chooses up to 30 work items from the agent registry. Each item declares an assigned agent, dependencies, validation commands, a unique managed branch, and `ownedPaths`. On Linux/Docker, use directory subtree grants such as `project:/src/component/**`: the pinned Codex runtime cannot execute exact-file write grants safely, and DevAgents rejects them before calling the model. The domain also supports exact paths for compatible runtimes. Ownership can narrow a role’s permissions, never expand them. Multi-item plans also select an integration agent whose existing permissions cover every owned path and include combined validation commands. Single-item plans use their own validation and `integration: null`. Before a plan is stored or offered for approval it is checked with the same rules execution enforces: every item and the integration step need at least one supported validation command, every item needs a writable implementer with the required capabilities, a reviewer must exist that is independent of every implementer and the integration agent, and on Linux every effective write grant must be a directory subtree. A plan that fails these checks fails the task during `planning` and is never presented for approval; execution re-applies the same checks.

Use `tasks show TASK_ID` to inspect and approve the plan, `tasks items TASK_ID` for each item’s progress/worktree/commit, and `tasks evidence TASK_ID` for runs, validation, checkpoints and integration decisions. A plan-approval wait stops all implementation workers. For parallel work by one role, set that role’s `concurrency` above 1; different roles can run concurrently at their existing limits.

Each worker branches from a private snapshot of results already integrated into the task worktree. Successful item validation and independent review produce a private work-item commit. These commits and dependency checkpoints are intermediate evidence, not final task approval. Changes are combined with three-way patch application in the task worktree. Conflicts become an explicit integration-agent repair bounded by `maxRepairCycles`. A repair counts as resolved only when the file content is clean: any `<<<<<<<`, `|||||||` or `>>>>>>>` line fails it, and a bare `=======` line fails it when the file has more of them than either side had before the merge, so Markdown heading underlines are allowed while leftover dividers are not; Git must also report no unmerged entry. Unresolved conflicts stop the task and preserve its worktrees. Repository-defined filters and custom merge drivers are refused.

After integration, all item checks and the combined checks run again. A reviewer distinct from all implementers and the integration agent must approve the complete diff before one final commit is created on the task branch. Per-item repair budgets and a separate shared integration repair budget are bounded. Cancellation or failure drains sibling workers and blocks unstarted dependents; item evidence records why each worker stopped (`failed`, `aborted` by a sibling failure, `cancelled` by the user, or `interrupted` by a service shutdown). A private checkpoint may already exist when cancellation arrives; a cancelled task never advances to the final combined commit. Restart recovery preserves paths/evidence and marks interrupted tasks failed rather than replaying them automatically. Nothing is cleaned up automatically: a finished task leaves its task worktree, item worktrees and item branches in place until you run `tasks cleanup TASK_ID`, which removes only worktrees registered under the data directory for that task and only branches named `codex/devagents-<task-id>…`, keeps a completed task’s branch (the reviewed commit), and records what it removed as evidence. It refuses active tasks and anything it cannot prove it created.

## Configuration and agents

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

Codex uses a dedicated profile with ChatGPT device login or an OpenAI API key. For the same guided setup on native Node.js:

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

Anthropic API-key configuration is represented; its adapter is planned for M4. Third-party Claude subscription login needs an officially permitted integration, as explained in [M0 findings](docs/M0_FINDINGS.md). The container does not include Claude.

## API and security

Task retries reuse the same `Idempotency-Key` and submitted input. Defaults resolve only on the first successful submission, so later mode/team changes do not change the task returned by a retry. For new submissions, omitting a mode differs from explicitly selecting it, even when it matches the default; changed input requires a new key. Older request records remain supported, but their fingerprints cannot distinguish an explicit mode from a mode inherited at submission.

The CLI authenticates using `<data-directory>/api-token` (mode `0600`). The service sets the data directory itself to mode `0700` on every start, even if it already existed with wider permissions. Keep this directory private. Only `/health`, the redirect at `/` and the static UI shell under `/ui/` are unauthenticated; every data route needs the bearer token or a browser session (see [Browser UI](#browser-ui)). Bearer requests carrying an `Origin` header are rejected; no CORS is enabled. This is a single-user local service.

Endpoints: `GET/POST /projects`, `GET /agents?projectId=...`, `GET /overview`, `GET /status`, `GET/POST /tasks` (`limit`, `before`, `projectId`, repeatable `state`), `GET /tasks/:id`, `GET /tasks/:id/events?after=`, `GET /tasks/:id/evidence?after=` and `/evidence/:sequence`, `GET /tasks/:id/items`, `POST /tasks/:id/{mode,plan,approve,cancel,run,cleanup}`; browser session routes `POST /ui/bootstrap` (bearer only), `GET /ui/login`, `GET /ui/session`, `POST /ui/logout`. `GET /tasks` returns a page of summaries (id, project, state, version, mode, request excerpt, branch, item count, commit or error) with a `nextBefore` cursor and project-wide state `counts`; `GET /tasks/:id` returns the full record including the plan, agent snapshot and history-derived `approval` status. Evidence text previews are bounded to 16 KB (1 MiB on the single-entry route); truncated entries also carry separately bounded `metadata` for validation/review state and attribution. Task creation requires `Idempotency-Key`; bodies use JSON. Approval includes the reviewed `version`.

The adapter pins Codex CLI 0.160.1 and builds a named permission profile from role paths. Read grants support exact paths and subtree `/**` grants. Linux/Docker write grants must use directory subtrees; exact-file writes are rejected when the plan is validated and again by the sandbox, with an actionable error, and are never widened automatically. Other glob forms fail closed. Read-only planning/review and writable implementation use separate processes. The Tech Lead keeps the shell tool during planning (`allowCommands: true` in `tech-lead.yaml`) so it can inspect files, but that process has a read-only project, a writable temp directory only and no network; repository content can therefore run code inside that sandbox before any approval. Override `tech-lead` with `allowCommands: false` to plan from the file list and prompt alone. Shells and patches are sandboxed; tool networking, delegated agents, plugins, hooks, browser tools and web search are disabled. Runtime/user/repository configuration is ignored. Known secret files, Git metadata and existing symlinks/hardlinks are denied; the worktree is scanned afresh before every sandbox launch (never cached), a directory whose every entry is denied is denied as a whole, and the scan is bounded by `workspaceScanLimit` (default 200000 entries), failing closed with an actionable error when exceeded. Write permission also implies filesystem read access to that path. Known limits: the scan costs one directory walk per engine or validation call; hardlinked package stores (pnpm) and `node_modules/.bin` symlinks stay denied, so validation scripts that invoke binaries through `.bin` do not run; raising the limit for very large worktrees lengthens each launch.

Validation supports `node --test`, `npm test`, and `npm run test/typecheck/lint/build` in a read-only worktree with writable temporary storage. Validation output is captured up to 1 MiB; beyond that the head and tail are kept with a truncation marker, the result is recorded as evidence and counts as a failed validation so the implementer is asked to reduce output. Git listings and diffs that exceed their buffers fail with a `git_output_limit` error naming the command. Commands cannot install dependencies over the network or write build output into the project. Install required dependencies into the managed worktree while paused at plan approval; ignored dependencies from the original checkout are not copied. Projects needing generated output directories require a later scoped build policy. This initial slice commits regular text files only and checks permissions, branch identity and diff integrity before commit. Every implementation call is bracketed by a snapshot of the worktree's hidden files (untracked paths the ignore rules exclude, such as installed dependencies), fingerprinted by inode, size, mode and kernel ctime. A worker that creates, modifies or deletes a hidden file, or hides a new file by changing ignore rules, fails the task before validation runs, because such files would influence tests without appearing in review or the commit. Dependencies installed into the worktree before implementation are unaffected as long as they stay unchanged.

Git helpers disable hooks/fsmonitor and global/system attributes; worktree creation rejects repository filters. Redaction has two tiers. Model prompts, stored task requests and plans, and API/CLI output remove known secret values (configured provider keys and environment variables whose names look like credentials) plus unmistakable credential tokens (`sk-…`, `ghp_…`, `github_pat_…`) while leaving code such as `token: string` intact, so reviewers and repairing implementers see the real diff. Events, evidence and service logs additionally mask `key=value` assignments, bearer headers and credential-looking object keys, so quoted code in evidence may show `[REDACTED]`. Keep secrets out of task requests. Approval applies to the planned task; the reviewed local commit is an atomic finalization phase, during which cancellation returns a conflict. Interrupted finalization is marked failed for manual inspection and never automatically repeated.

The container is non-root, has a read-only root filesystem, dropped capabilities, resource limits, temporary `/tmp` and a data volume. These service controls alone are not a worker sandbox.

The default two-worker configuration has a 512-process/thread cap, 2 CPUs and 1 GiB of memory. The Docker suite runs two Codex protocol workers concurrently under these limits. Raising agent concurrency requires checking container capacity as well as role permissions.

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
- Interrupted work: a service shutdown (`SIGTERM`, `docker compose stop/restart`) marks the running task `failed` with the reason "Service shutdown interrupted execution"; a crash leaves it in its execution state and the next start marks it failed during recovery. Only an explicit `tasks cancel` produces `cancelled`. Automatic resumption is not implemented.

For a **live container fixture**, after starting and unlocking the service:

```sh
./devagents start
docker compose exec -T devagents node scripts/m3-smoke.mjs --live
```

It creates and removes only a temporary fixture repository and uses the running container’s unlocked credential profile. It does not register or modify your projects.

The live M3 container fixture passed with ChatGPT sign-in on 2026-10-29 and again on 2026-10-30 at `db95711`: three items, two parallel workers, dependency integration, actual tests, independent item/combined reviews and a final local commit. The original checkout stayed unchanged. Earlier failures led to fixes for the planner schema, Linux write-scope compatibility, container process capacity and review-stage context; see [compatibility findings](docs/M0_FINDINGS.md). Native authenticated and AMD64 execution remain unverified.
