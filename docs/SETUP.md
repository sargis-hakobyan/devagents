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

Claude and local-model buttons are disabled until their execution adapters exist. This increment does not add M4 or claim compatibility with arbitrary providers.

## Add an existing project

Finish provider sign-in, return to the still-open launcher terminal, and choose **Add a project**. Or run:

```sh
./devagents project add
```

Enter a project name and its absolute host folder path. The launcher shows the generated project ID before mounting: uppercase letters become lowercase and spaces become dashes (`TestProject` → `testproject`, `Test Project` → `test-project`). Invalid names are rejected immediately and can be entered again. The launcher validates a Git checkout through a temporary read-only Docker mount, shows the selected folder, and asks before applying it. It creates `.devagents/compose.projects.yaml`, restarts the service, unlocks credentials again, registers the container path and opens a fresh setup link. No manual YAML editing or host/container path translation is needed. New registrations use plan approval; existing project settings are preserved.

Only explicit project folders are mounted. Root/home directories and ambiguous paths with commas or line breaks are refused. Existing mappings cannot be silently repointed. User `compose.override.yaml` is preserved and included alongside generated mounts. Finish/cancel active work and authentication before adding mounts. On Linux, the container's non-root UID 1000 must have permission to read and write the chosen checkout.

Use the launcher for subsequent starts so generated mounts are included. Plain `docker compose up` does not load `.devagents/compose.projects.yaml` or unlock credentials. `./devagents start --build` forces a rebuild when troubleshooting.

Browser setup cannot browse host folders or control Docker. The host terminal intentionally owns this step; the service has no Docker socket mount. Native installations and folders already mounted into the service can use **Register it here** in browser setup.

## Team and first task

DevAgents creates a **Starter team** automatically: Tech Lead, Developer, QA Engineer and independent Code Reviewer. It becomes the default for new projects, so you can submit work immediately after connecting Codex and registering your project. Teams lets you rename it, edit members, add custom roles or choose another team.

Existing custom defaults and explicitly cleared defaults are preserved. On upgrade, existing projects with untouched team settings receive the starter too. Restart never duplicates, resets or restores an archived starter. If the starter is archived or not ready under your configured engine/provider, it is not assigned automatically; choose a ready team in Teams. Each task still freezes its own team revision and model settings when submitted; existing task snapshots never change.

Then select **Submit work**, describe the change, and add acceptance criteria. Plan approval lets you review the plan before implementation starts. Completed work has tests, independent review, a local commit and a read-only diff. Nothing is automatically merged or pushed.

Terminal users can finish team and task setup with the existing `teams` and `tasks` CLI commands documented in the [technical reference](REFERENCE.md), or open the printed dashboard link.

## Troubleshooting

- **Docker unavailable:** start Docker and repeat the same command.
- **Vault locked:** unlock your OS keychain and rerun `./devagents start`. The service may remain up for inspection; provider sign-in stays disabled until the vault is unlocked.
- **Lost browser session:** run `./devagents setup --browser` for a fresh one-time link. Links expire after ten minutes and are consumed once.
- **Lost sign-in response:** inspect the current sign-in state before starting another attempt. No login or model request is automatically replayed.
- **Project setup interrupted:** run `./devagents project add` again with the same name and folder. Existing identical mappings and registrations are reused.
- **Another launcher is running:** finish or exit that terminal first. Interrupted launcher locks with a dead PID are recovered on the next start.
- **Quota/model access:** saved credentials do not guarantee allowance or model availability. Read the task's preflight error; DevAgents does not silently switch billing methods.

Public prebuilt image distribution is still release work. This checkout builds locally and caches its image; no unpublished image URL or installer is advertised.

## Optional DevAgents rules

Extra DevAgents restrictions are **off by default** for new tasks. The engine sandbox accepts project-specific validation commands and permits generated output in the isolated worktree. Installed tooling, sandbox access and dependency availability still determine whether a command succeeds. Claude execution is not available yet.

To enable the additional command allowlist and role scopes, add `DEVAGENTS_RULES=true` to `.env` in the DevAgents folder, then run `./devagents start`. Use `false` to turn them off again. Native configuration also supports `devagentsRules: true` in the YAML file selected by `DEVAGENTS_CONFIG`.

Settings shows the running default; every task keeps the setting it had at submission. Submit a new task after changing it. A failed task is not restarted automatically. See the [execution-policy details and remaining boundaries](REFERENCE.md#optional-extra-rules).

## Project environment preparation

With extra DevAgents rules **off** (the default), the assigned coding agent prepares each task worktree after approval, before implementation. It inspects the project's tooling, installs missing dependencies or local runtimes, and runs needed install scripts, hooks, generation and builds. There is no npm/pnpm-only allowlist in this mode. Package-manager policies still apply; DevAgents does not automatically override dependency-build approvals. The current executable engine is Codex; this does not add Claude or import a desktop app's tools/settings.

Setup, implementation and validation have network access inside the engine sandbox. They can write the isolated worktree and a dedicated, secret-free HOME for that worktree. Tools installed under `$HOME/bin` or `$HOME/.local/bin` stay on PATH in subsequent calls. Tool HOME caches are retained in service data after worktree cleanup; they are not reused across tasks. Shell exports and background processes do not survive a call; persistent service provisioning is not implemented. The original checkout, saved credentials, Git metadata and arbitrary host writes remain unavailable. Recognized setting-only `.npmrc` files are exposed read-only; authentication settings, comments and unrecognized configuration remain protected. Private package registries that require saved authentication can still block setup. Do not disable checks or weaken tests to make setup appear successful.

Activity records the setup agent, commands, output and readiness or a concrete blocker. Setup uses the configured execution timeout. A reported setup blocker or a validation failure caused by a missing executable/dependency receives one environment recovery per worktree without consuming the code-repair budget. Validation reruns after recovery. Baseline source/test defects are handed to implementation and review through setup notes rather than requiring an already-green project before coding. Ordinary test failures use the existing bounded repair flow. Setup configuration/source changes are included in independent review; validation itself must not mutate reviewed source. DAG workers each prepare their own checkout; integration prepares the combined result. A failed task stays failed: after updating DevAgents, submit a new task. Existing failed worktrees are preserved.

With extra rules **on**, preparation uses the restricted Node adapter: npm with `package-lock.json`, or pnpm 10 with `pnpm-lock.yaml`, including workspaces. It checks runtime requirements, downloads locked dependencies in a separate metadata-only sandbox, skips lifecycle scripts and pnpm hooks, and copies checked dependency trees into each worktree. It repeats when dependency inputs change. Coding and validation commands stay offline; unsupported setup stops without code repair. Commit manifests, locks, workspace configuration and patches, and ignore `node_modules`. Native execution uses its installed Node/npm. Docker supplies Node 24.22.1; bundled pnpm is 10.34.9. Restricted pnpm preparation uses that fixed version, while default agent-managed setup can select the project's version.

Both modes retain cancellation, resource limits, independent review, local-only finalization and original-checkout protection. Generated/ignored files can influence default-mode validation without entering the commit. Successful preparation does not guarantee all project tests will pass or provide missing services, credentials, system privileges or unsupported engine integrations.

## Large projects and execution budgets

Docker defaults to 4 GiB RAM and 4 CPUs shared by DevAgents, agents and project commands. Configure `DEVAGENTS_MEMORY`, `DEVAGENTS_CPUS` and `DEVAGENTS_PIDS` in `.env`, then restart with `./devagents start`. Allocate enough memory to Docker itself too. These limits govern project installs/builds/tests, not cloud model inference.

Default agent calls may run for 30 minutes, individual validation commands for 10 minutes, and each implementation/review loop permits three repair cycles. Explicit YAML settings still override these defaults. Setup uses lightweight prerequisite probes; full validation runs after implementation.

With extra rules off, large dependency trees do not trigger a filesystem-entry limit. The complete tree is still scanned for protected paths and unsafe links using streamed directory traversal. Strict mode retains the configurable `workspaceScanLimit`. Text files have no 512 KiB commit restriction; review-diff and evidence budgets remain separate. Review prompts preserve every validation command and exit code, with marked head/tail previews for long output. Engine progress is streamed without a cumulative-output failure; malformed or oversized individual protocol records still fail explicitly.

Independent reviewers also receive the latest implementation's report and up to 20 observed command results from the same worktree, with bounded previews. This lets them assess additional checks performed during a repair, including temporary-service tests. These are supplementary evidence; the declared validation commands still run, and skipped checks are not treated as passes.
