# Setup

DevAgents currently runs on macOS or desktop Linux with Docker Compose. Install and start Docker first. Credential encryption uses macOS Keychain, or Linux `openssl`, `secret-tool` and an unlocked desktop Secret Service. There is no plaintext fallback on headless Linux.

From the cloned DevAgents folder:

```sh
./devagents start
```

The launcher builds a local image on first use or when source files change, starts the service, unlocks its encrypted vault, then offers:

- **Browser** (default): opens a one-time local sign-in link directly to guided setup.
- **Terminal**: the same Codex connection flow with hidden API-key input, followed by optional project registration.
- **Later**: leaves the service running and prints the setup link.

Use ↑/↓ and Enter in all setup choice menus, or type a number and press Enter. This includes provider sign-in, the optional connection test, adding a project and confirming its mount. Saved login, skipping the test and declining a mount are selected by default where applicable. Project names, paths and hidden API-key input remain typed fields. Limited terminals retain plain numbered input. Ctrl+C cancels setup and leaves the service running.

No host Node.js installation is needed for Docker. Once a connection and project are saved, normal startup prints a dashboard link without repeating setup. `./devagents setup` always offers the setup menu. `--browser`, `--terminal` and `--later` select a route directly. Noninteractive default startup prints a link and never prompts or makes a model request.

## Connect Codex

In browser setup, select **Sign in with ChatGPT**, then **Open ChatGPT sign-in**. The provider page asks for the one-time code shown by DevAgents. Device login may need enabling in your ChatGPT Security settings or workspace permissions. DevAgents uses the official CLI's device flow and does not collect your account password. See [OpenAI's authentication documentation](https://learn.chatgpt.com/docs/auth).

Alternatively, select **Use an OpenAI API key**. Enter the key in the password field and save it. It goes to the same-origin local service and the Codex CLI's stdin, never to process arguments, browser storage, configuration files or task history. The field is cleared when sent. Saved credentials cannot be retrieved through the setup API.

Docker credentials are encrypted in the persistent volume with a separate encryption key held by your OS credential store. Decrypted credentials exist only in the container's private tmpfs during execution. Native installation uses the OS keyring. Sign-in is blocked during active task execution, and new execution is blocked while sign-in runs. One browser session or terminal owns each login; other sessions cannot retrieve its code. Reload restores the in-progress login for the same session; logout cancels it. Restart ends in-progress login and requires a new browser link. Device login expires after ten minutes; API-key saving has a bounded subprocess timeout.

A saved connection is not a paid model-access test. Browser setup never sends a model request. Terminal setup offers a test only after explaining its usage cost; it is skipped by default. Existing `--auth chatgpt|api-key|saved`, `--replace-key` and `--test-connection` options select terminal setup.

Claude is selectable per team member. Local-model execution remains unavailable until a compatible adapter is registered.

## Add an existing project

Finish provider sign-in, return to the still-open launcher terminal, and choose **Add a project**. Or run:

```sh
./devagents project add
```

Enter a project name and its absolute host folder path. The name is free text (up to 80 characters), is shown everywhere and can be changed later; the service generates the project's ID, a UUID you never type. A name already used by an active project is rejected immediately and can be entered again. The launcher validates a Git checkout through a temporary read-only Docker mount, shows the selected folder, and asks before applying it. It creates `.devagents/compose.projects.yaml`, restarts the service, unlocks credentials again, registers the container path and opens a fresh setup link. No manual YAML editing or host/container path translation is needed. New registrations use plan approval; existing project settings are preserved.

The repository must have a local `main` branch. Every new task worktree starts from its current committed tip on a new task branch, even if your checkout is on another branch or contains local edits. Update local `main` yourself when upstream changes are needed; DevAgents does not fetch or pull automatically. Existing task worktrees keep their recorded starting commit.

The web registration form shows field-level errors and explains why Register project is disabled. The form asks for a project name, not an ID. Paths must start with `/`; `~`, parent traversal and the filesystem root are rejected. Spaces within folder names are allowed. Docker users default to **Folder on my computer**: enter the absolute host path and select **Prepare setup command**. Run the generated `./devagents project add --name … --path …` command in a terminal from the DevAgents directory. Arguments are shell-quoted, the launcher still validates the folder and asks before mounting, and preparing a command does not register a project. An optional disclosure previews the host/container mapping. **Already mounted in Docker (advanced)** enables direct registration using an existing container path; `/projects` is a convention, not a required prefix. Switching between the two clears the path to avoid sending a host path as a container path. Native installations keep direct registration. Existing Docker project cards explicitly label internal paths. Input is kept after a server refusal so you can correct it.

Only explicit project folders are mounted. Root/home directories and ambiguous paths with commas or line breaks are refused. Existing mappings cannot be silently repointed. User `compose.override.yaml` is preserved and included alongside generated mounts. Finish/cancel active work and authentication before adding mounts. On Linux, the container's non-root UID 1000 must have permission to read and write the chosen checkout.

Use the launcher for subsequent starts so generated mounts are included. Plain `docker compose up` does not load `.devagents/compose.projects.yaml` or unlock credentials. `./devagents start --build` forces a rebuild when troubleshooting.

Browser setup cannot browse host folders or control Docker. The host terminal intentionally owns this step; the service has no Docker socket mount. Native installations and folders already mounted into the service can use **Register it here** in browser setup.

## Team and first task

DevAgents creates a **Starter team** automatically: Tech Lead, Developer, QA Engineer and independent Code Reviewer. It becomes the default for new projects, so you can submit work immediately after connecting Codex and registering your project. Teams lets you rename it, edit members, add custom roles or choose another team.

Existing custom defaults and explicitly cleared defaults are preserved. On upgrade, existing projects with untouched team settings receive the starter too. Restart never duplicates, resets or restores an archived starter. If the starter is archived or not ready under your configured engine/provider, it is not assigned automatically; choose a ready team in Teams. Each task still freezes its own team revision and model settings when submitted; existing task snapshots never change.

Then select **Submit work**, describe the change and expected outcome in the task description. Plan approval shows the proposed change, assigned team members, planned checks, and risks in plain language. Expand **Technical details** for implementation steps, file paths and commands before approving. New plans produce this prose in the existing planning call; older saved summaries remain unchanged. Completed work has tests, independent review, a local commit and a read-only diff. Nothing is automatically merged or pushed.

Terminal users can finish team and task setup with the existing `teams` and `tasks` CLI commands documented in the [technical reference](REFERENCE.md), or open the printed dashboard link.

## Troubleshooting

- **Docker unavailable:** start Docker and repeat the same command.
- **Container exits during startup:** inspect `docker compose logs --tail=100 devagents`. A full Docker data disk can prevent SQLite from acquiring the service lock; older builds incorrectly reported this as "Another service owns this data directory". Check `docker system df`, reclaim unused build cache or increase Docker's disk capacity, then rerun `./devagents start`. Free host disk space does not guarantee free space inside Docker's virtual disk. Preserve the `devagents-data` volume: it holds task history and encrypted credentials.
- **Vault locked:** unlock your OS keychain and rerun `./devagents start`. The service may remain up for inspection; provider sign-in stays disabled until the vault is unlocked.
- **Lost browser session:** run `./devagents setup --browser` for a fresh one-time link. Links expire after ten minutes and are consumed once.
- **Lost sign-in response:** inspect the current sign-in state before starting another attempt. No login or model request is automatically replayed.
- **Project setup interrupted:** run `./devagents project add` again with the same name and folder. A folder that was already mounted but not yet registered is finished under the ID it was mounted with.
- **Another launcher is running:** finish or exit that terminal first. Interrupted launcher locks with a dead PID are recovered on the next start.
- **Quota/model access:** saved credentials do not guarantee allowance or model availability. Read the task's preflight error; DevAgents does not silently switch billing methods.

Public prebuilt image distribution is still release work. This checkout builds locally and caches its image; no unpublished image URL or installer is advertised.

## Optional DevAgents rules

Extra DevAgents restrictions are **off by default** for new tasks. The engine sandbox accepts project-specific validation commands and permits generated output in the isolated worktree. Installed tooling, sandbox access and dependency availability still determine whether a command succeeds. Codex and Claude use their registered adapters within these boundaries; see [Claude setup](#claude) for its verification status and connection requirements.

To enable the additional command allowlist and role scopes, add `DEVAGENTS_RULES=true` to `.env` in the DevAgents folder, then run `./devagents start`. Use `false` to turn them off again. Native configuration also supports `devagentsRules: true` in the YAML file selected by `DEVAGENTS_CONFIG`.

Settings shows the running default; every task keeps the setting it had at submission. Submit a new task after changing it. A failed task is not restarted automatically. See the [execution-policy details and remaining boundaries](REFERENCE.md#optional-extra-rules).

## Project environment preparation

With extra DevAgents rules **off** (the default), the assigned coding agent prepares each task worktree after approval, before implementation. It inspects the project's tooling, installs missing dependencies or local runtimes, and runs needed install scripts, hooks, generation and builds. There is no npm/pnpm-only allowlist in this mode. Package-manager policies still apply; DevAgents does not automatically override dependency-build approvals. The current executable engine is Codex; this does not add Claude or import a desktop app's tools/settings.

Setup, implementation and validation have network access inside the engine sandbox. They can write the isolated worktree and a dedicated, secret-free HOME for that worktree. Tools installed under `$HOME/bin` or `$HOME/.local/bin` stay on PATH in subsequent calls. Tool HOME caches are private to each worktree and not reused across tasks. The provided pnpm command pins its store and metadata cache under `$HOME/package-cache`, outside the checkout, so sandbox mount detection cannot put `.pnpm-store` among source changes. The managed pnpm wrapper takes precedence on PATH while still using the selected Node runtime and project pnpm version. Other caches should also stay under the private HOME. Unignored dependency folders produce an actionable setup error before expanding their full file listing; they are never silently excluded from review. Terminal-task cleanup removes them automatically, including leftovers after explicit worktree cleanup. Shell exports and background processes do not survive a call; persistent service provisioning is not implemented. The original checkout, saved credentials, Git metadata and arbitrary host writes remain unavailable. Recognized setting-only `.npmrc` files are exposed read-only; authentication settings, comments and unrecognized configuration remain protected. Private package registries that require saved authentication can still block setup. Do not disable checks or weaken tests to make setup appear successful.

Activity records the setup agent, commands, output and readiness or a concrete blocker. Setup uses the configured execution timeout. A reported setup blocker or a validation failure caused by a missing executable/dependency receives one environment recovery per worktree without consuming the code-repair budget. Validation reruns after recovery. Baseline source/test defects are handed to implementation and review through setup notes rather than requiring an already-green project before coding. Ordinary test failures use the existing bounded repair flow. Setup configuration/source changes are included in independent review; validation itself must not mutate reviewed source. DAG workers each prepare their own checkout; integration prepares the combined result. A failed task stays failed: after updating DevAgents, submit a new task. Unfinished files from failed tasks are archived before their worktrees are removed.

With extra rules **on**, preparation uses the restricted Node adapter: npm with `package-lock.json`, or pnpm 10 with `pnpm-lock.yaml`, including workspaces. It checks runtime requirements, downloads locked dependencies in a separate metadata-only sandbox, skips lifecycle scripts and pnpm hooks, and copies checked dependency trees into each worktree. It repeats when dependency inputs change. Coding and validation commands stay offline; unsupported setup stops without code repair. Commit manifests, locks, workspace configuration and patches, and ignore `node_modules`. Native execution uses its installed Node/npm. Docker supplies Node 24.22.1; bundled pnpm is 10.34.9. Restricted pnpm preparation uses that fixed version, while default agent-managed setup can select the project's version.

Both modes retain cancellation, resource limits, independent review, local-only finalization and original-checkout protection. Generated/ignored files can influence default-mode validation without entering the commit. Successful preparation does not guarantee all project tests will pass or provide missing services, credentials, system privileges or unsupported engine integrations.

## Large projects and execution budgets

Independent tasks can run concurrently in native and Docker installations. After a Docker restart, queued compute waits for the launcher to unlock both credential vaults; mode and approval waits can still be persisted. The default remains one task. Use **Settings → Parallel tasks** or `npm run cli -- config task-concurrency 2` (native) to admit two tasks without restarting. In Docker, run `docker compose exec devagents node dist/cli/main.js config task-concurrency 2`. Omit the number to view the current value. Saved changes persist in the data database and override the YAML/environment task limit; increasing capacity allows queued work to start within the next scheduler tick, while lowering it leaves active tasks running and delays new starts until below the limit. Before any setting is saved, `DEVAGENTS_MAX_CONCURRENT_TASKS=2` in the launcher's `.env` sets the startup default (restart required). `DEVAGENTS_MAX_CONCURRENT_OPERATIONS=2` bounds engine calls, validation and preparation operations across all tasks. Native YAML uses `maxConcurrentTasks` (1–8) and `maxConcurrentOperations` (1–16). For startup defaults, environment values take precedence over YAML. Existing `concurrency` still limits work-item waves inside each task. Approval waits release task capacity, and each task retains its own branch, worktree, repair budget and cancellation. Increase limits only within the machine's CPU, memory and disk capacity.

Docker defaults to 4 GiB RAM and 4 CPUs shared by DevAgents, agents and project commands. Configure `DEVAGENTS_MEMORY`, `DEVAGENTS_CPUS` and `DEVAGENTS_PIDS` in `.env`, then restart with `./devagents start`. Allocate enough memory to Docker itself too. These limits govern project installs/builds/tests, not cloud model inference.

Default agent calls may run for 30 minutes, individual validation commands for 10 minutes, and each implementation/review loop permits three repair cycles. Explicit YAML settings still override these defaults. Setup uses lightweight prerequisite probes; full validation runs after implementation.

With extra rules off, large dependency trees do not trigger a filesystem-entry limit. The complete tree is still scanned for protected paths and unsafe links using streamed directory traversal. Strict mode retains the configurable `workspaceScanLimit`. Text files have no 512 KiB commit restriction; review-diff and evidence budgets remain separate. Review prompts preserve every validation command and exit code, with marked head/tail previews for long output. Engine progress is streamed without a cumulative-output failure; malformed or oversized individual protocol records still fail explicitly.

Independent reviewers also receive the latest implementation's report and up to 20 observed command results from the same worktree, with bounded previews. This lets them assess additional checks performed during a repair, including temporary-service tests. These are supplementary evidence; the declared validation commands still run, and skipped checks are not treated as passes.

## Completed-task resource cleanup

Completed, failed and cancelled tasks automatically compact regenerable dependencies, tool caches and recorded run scratch after execution drains, then remove managed worktrees. Dirty checkouts first receive a private recovery archive under `/data/recovery` in Docker (`<data-dir>/recovery` natively), preserving unfinished files and staged changes. All task and item branches, reviewed commits, credentials and history survive. The Result tab shows cleanup status and archive locations. Startup recovery catches older finished tasks and marks interrupted setup tasks failed without replaying them. To keep working environments for debugging, set both `DEVAGENTS_CLEANUP_TERMINAL_TASKS=false` and `DEVAGENTS_COMPACT_COMPLETED_TASKS=false` in `.env` and restart with `./devagents start`. Native YAML accepts `cleanupTerminalTasks: false` and `compactCompletedTasks: false`. Missing ownership proof, archive failures or unsafe filesystem contents defer cleanup and leave the checkout intact. See [storage recovery](REFERENCE.md#storage-recovery-and-task-compaction) for recovery instructions and limits.

## Claude

Connect Claude before submitting work to a team with enabled Claude members. DevAgents checks each enabled member's engine/provider prerequisites before planning or creating a worktree. Disabled members and globally disabled QA are skipped. If a task already failed for missing sign-in, connect the provider and submit a new task; the failed task and its evidence are preserved. An idle Ready task does not block sign-in, but queued or running work does. Saved credentials do not guarantee model access or quota.

Open **Settings → Setup → Connect Claude**. Choose an Anthropic API key, or choose **Use my Claude subscription** for your personal local connection. Generate a subscription token with the official `claude setup-token` command on your computer, then paste it into the password field. Never paste credentials into task descriptions, chat, YAML or source files. The generated token may expire; replace it through the same form when necessary. There is no automatic browser OAuth flow or token refresh in DevAgents.

The Docker service encrypts both credential types using a separate Claude vault and the existing OS-keychain master key. Plaintext exists only in the private tmpfs runtime. Native services can receive `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` through their environment; browser credential saving currently requires the Docker vault. Environment API keys take precedence over subscription tokens. API-key providers with an explicit `apiKeyEnv` require that variable and never fall back to subscription billing.

For terminal setup against the running Docker service, use `docker compose exec devagents node dist/cli/main.js auth claude --method api-key` or `docker compose exec devagents node dist/cli/main.js auth claude --method subscription`. Input is hidden. A saved connection is not a model-access or quota test; setup does not send a paid request.

In **Teams**, tick what each member does: **Plans work**, **Implements**, **Reviews** or **Tests**. A planner cannot take the other three; the working responsibilities can be combined, and an implementer needs a write scope. Choose each member's **Effort** (Low, Medium or High; Medium unless changed). In **Teams**, edit each member's Engine and Model. The engine automatically selects a compatible provider. A **Connection** selector appears under **Advanced** only when multiple compatible connections are configured or an existing selection needs repair. The Model dropdown offers documented models for that engine, **Default**, and **Custom model ID** for another model or alias supported by your account. Changing Engine resets Model to Default. Default uses the global configured model for the default engine, otherwise the engine's runtime default. Until you load a list, the dropdown shows a built-in one checked against the official catalogs on 2026-11-03. **Refresh list** under the dropdown asks the member's engine for the models it offers your signed-in account and saves that list; models that appeared since the previous load are marked "new". Nothing is requested when the page opens, a failed load keeps the list shown before, and a listed model is not proof of access. Existing custom IDs are preserved. Existing tasks retain their frozen team configuration. If your custom YAML explicitly lists providers, add `{id: anthropic, kind: anthropic, auth: login}` to that list.

Claude uses the pinned Agent SDK runtime and DevAgents' sandboxed workspace tools. The pinned Codex CLI is still required for OS sandbox enforcement and validation, even for an all-Claude team. No built-in Claude shell, repository hooks, plugins, user settings or host filesystem tools are enabled. Token counts include input, cache reads, cache creation and output; Claude cost estimates are currently unavailable because the existing pricing model does not represent cache-creation rates.

Anthropic's [Agent SDK guidance](https://code.claude.com/docs/en/agent-sdk/overview) requires approval for third-party products offering claude.ai login or subscription rate limits. A personal subscription is not that approval. This local credential option does not establish authorization to distribute such an integration. Use API keys for product deployments unless approved by Anthropic.

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


### Refreshing built-in role instructions

Run `./devagents start` after updating this checkout. The launcher fingerprints source and built-in agent files and rebuilds the image when they change; a container-only restart does not rebuild it.

Saved team members are explicit copies of templates, so restart preserves their instructions and model choices. Update an existing member's instructions in Teams to adopt a revised default; preserve any custom instructions. New template copies use the updated defaults. Already submitted tasks retain their frozen team snapshot.

Separate agent QA remains disabled by default (`qaEnabled: false`). Developer validation and independent review remain mandatory. If QA is explicitly enabled later, its verification stage runs before final review; parallel QA/review is not currently scheduled.

### Interrupted parallel executions

After an abrupt service interruption, DevAgents preserves uncertain task environments and marks them as requiring inspection. A durable recovery blocker prevents those tasks from being replayed or automatically compacted when prior worker termination cannot be verified. Other safely queued work can continue. Do not remove a retained environment until its worker processes have stopped; the current release does not offer a general failed-task resume or a UI action that overrides this protection.
