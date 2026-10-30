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

Enter a project name and its absolute host folder path. The launcher validates a Git checkout through a temporary read-only Docker mount, shows the selected folder, and asks before applying it. It creates `.devagents/compose.projects.yaml`, restarts the service, unlocks credentials again, registers the container path and opens a fresh setup link. No manual YAML editing or host/container path translation is needed. New registrations use plan approval; existing project settings are preserved.

Only explicit project folders are mounted. Root/home directories and ambiguous paths with commas or line breaks are refused. Existing mappings cannot be silently repointed. User `compose.override.yaml` is preserved and included alongside generated mounts. Finish/cancel active work and authentication before adding mounts. On Linux, the container's non-root UID 1000 must have permission to read and write the chosen checkout.

Use the launcher for subsequent starts so generated mounts are included. Plain `docker compose up` does not load `.devagents/compose.projects.yaml` or unlock credentials. `./devagents start --build` forces a rebuild when troubleshooting.

Browser setup cannot browse host folders or control Docker. The host terminal intentionally owns this step; the service has no Docker socket mount. Native installations and folders already mounted into the service can use **Register it here** in browser setup.

## Team and first task

Choose **Use recommended team** in setup to copy the Tech Lead, Developer, QA and independent Code Reviewer templates and set that team's immutable revision as the project's current default. With multiple projects, select one first. Existing task snapshots never change. You can choose or customize another team in Teams.

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
