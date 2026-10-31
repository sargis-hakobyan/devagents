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

After plan approval (or automatically in autonomous mode), DevAgents prepares the task worktree before implementation. The first adapter supports Node projects using npm with `package-lock.json`, or pnpm 10 with `pnpm-lock.yaml`, including workspaces. Commit your manifests, lockfile, workspace configuration and dependency patches; ignore `node_modules` in Git. The Docker image supplies Node 24.22.1 and DevAgents bundles pnpm 10.34.9. pnpm 10 declarations use this fixed patched version; other major versions are refused rather than downloaded silently. Native execution uses its installed Node/npm, so the project's `engines` requirements must match.

Preparation checks the runtime, installs with the lockfile frozen, and copies dependencies into each isolated worktree. It repeats when dependency inputs change, including before combined validation. The original checkout and its `node_modules` are not used or modified. Activity shows checking, installing, ready or failed environment evidence. Missing executables/dependencies stop with **Environment blocked**, without spending a code-repair attempt. A failed task stays failed; correct the environment and submit a new task. Existing failed worktrees remain available for inspection.

Downloads run in a separate sandbox containing dependency metadata and patches, with no source files, repository `.npmrc`, service credentials or inherited authentication. Lifecycle scripts, pnpm hooks and automatic package-manager switching are disabled. Model commands and validation remain offline. Preparation allows ten minutes per install and captures bounded output. An unchanged installation is reused within the current service process; there is no shared cross-project dependency cache yet.

Limits: private registry authentication, Git/file dependencies, dependency lifecycle builds, custom package-manager hooks/settings, automatic database/service startup, other pnpm majors, Yarn/Bun/Python/Java toolchain provisioning and arbitrary runtime downloads are not implemented. Projects needing these must use a future environment adapter or explicitly prepared tooling. Extra DevAgents rules still restrict package symlinks and generated files; use the default rules-off mode for ordinary pnpm workspaces. Preparation does not promise that all project tests will pass.
