# DevAgents

DevAgents is an open-source, local-first AI development-team orchestrator, being built to plan, delegate, implement, test and review changes with configurable agents and replaceable coding engines.

**Current status: M3 multi-agent execution implemented; live M3 acceptance pending.** A dynamic Tech Lead plans a task DAG and selects configured specialists. Independent items run in isolated worktrees with bounded concurrency; dependency results are integrated before downstream work starts. Real sandboxed checks and independent item/combined review gate the final local commit. Approval waits, bounded repairs, cancellation and execution evidence are persisted. Native and Docker checks are documented in [milestones](docs/MILESTONES.md), [compatibility findings](docs/M0_FINDINGS.md), and [decisions](docs/DECISIONS.md).

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
npm run cli -- tasks submit my-project "Add a greeting function" --key greeting-1
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

## Multi-agent plans and progress

The Tech Lead chooses up to 30 work items from the agent registry. Each item declares an assigned agent, dependencies, validation commands, a unique managed branch, and `ownedPaths` using exact paths or subtree `/**` grants. Ownership can narrow a role’s permissions, never expand them. Multi-item plans also select an integration agent whose existing permissions cover every owned path and include combined validation commands. Single-item plans use their own validation and `integration: null`.

Use `tasks show TASK_ID` to inspect and approve the plan, `tasks items TASK_ID` for each item’s progress/worktree/commit, and `tasks evidence TASK_ID` for runs, validation, checkpoints and integration decisions. A plan-approval wait stops all implementation workers. For parallel work by one role, set that role’s `concurrency` above 1; different roles can run concurrently at their existing limits.

Each worker branches from a private snapshot of results already integrated into the task worktree. Successful item validation and independent review produce a private work-item commit. These commits and dependency checkpoints are intermediate evidence, not final task approval. Changes are combined with three-way patch application in the task worktree. Conflicts become an explicit integration-agent repair bounded by `maxRepairCycles`; unresolved conflicts stop the task and preserve its worktrees. Repository-defined filters and custom merge drivers are refused.

After integration, all item checks and the combined checks run again. A reviewer distinct from all implementers and the integration agent must approve the complete diff before one final commit is created on the task branch. Per-item repair budgets and a separate shared integration repair budget are bounded. Cancellation or failure drains sibling workers and blocks unstarted dependents. A private checkpoint may already exist when cancellation arrives; a cancelled task never advances to the final combined commit. Restart recovery preserves paths/evidence and marks interrupted tasks failed rather than replaying them automatically.

## Configuration and agents

`DEVAGENTS_DATA_DIR` defaults to `.devagents`, and `DEVAGENTS_PORT` to `4310`. Set `DEVAGENTS_CONFIG` to a YAML file such as `examples/devagents.yaml`. The default OpenAI provider uses the saved Codex profile (including a saved API key); an explicitly configured `auth: api-key` with `apiKeyEnv` instead selects the existing environment-variable flow. The native process does not automatically load `.env`; `.env.example` documents variables. Compose uses `.env` for substitution only.

Six built-ins: Tech Lead, Developer, Backend Developer, Frontend Developer, QA Engineer and Code Reviewer. Add YAML and Markdown under `<data-directory>/agents/` or `<project>/.devagents/agents/`. Precedence is project > user > bundled `agents/builtin/`. Duplicate IDs within a directory fail validation. Definitions reload when the registry is requested and are snapshotted when a task creates its worktree.

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

Never put literal keys in commands, YAML, commits or task requests. Login state stays in the dedicated data directory/volume; host credentials are not copied. Device login may require account/workspace enablement. Dedicated container API-key login and ChatGPT device login are verified. The live M2 model fixture passed with ChatGPT sign-in on 2026-10-29; earlier API-key attempts were blocked by API quota. A missing login fails the task with a setup error before creating a worktree; after login, submit a new task with a new retry key.

Anthropic API-key configuration is represented; its adapter is planned for M4. Third-party Claude subscription login needs an officially permitted integration, as explained in [M0 findings](docs/M0_FINDINGS.md). The container does not include Claude.

## API and security

The CLI authenticates using `<data-directory>/api-token` (mode `0600`). Keep this directory private. Only `/health` is unauthenticated. Browser-origin requests are rejected; no CORS or browser UI is enabled. This is a single-user local service.

Endpoints: `GET/POST /projects`, `GET /agents?projectId=...`, `GET/POST /tasks`, `GET /tasks/:id`, `GET /tasks/:id/events`, `GET /tasks/:id/evidence`, `GET /tasks/:id/items`, `POST /tasks/:id/{mode,plan,approve,cancel,run}`. Task creation requires `Idempotency-Key`; bodies use JSON. Approval includes the reviewed `version`.

The adapter pins Codex CLI 0.160.1 and builds a named permission profile from role paths. The adapter supports exact paths and subtree `/**` grants; other glob forms fail closed. Read-only planning/review and writable implementation use separate processes. Shells and patches are sandboxed; tool networking, delegated agents, plugins, hooks, browser tools and web search are disabled. Runtime/user/repository configuration is ignored. Known secret files, Git metadata and existing symlinks/hardlinks are denied. Write permission also implies filesystem read access to that path.

Validation supports `node --test`, `npm test`, and `npm run test/typecheck/lint/build` in a read-only worktree with writable temporary storage. Commands cannot install dependencies over the network or write build output into the project. Install required dependencies into the managed worktree while paused at plan approval; ignored dependencies from the original checkout are not copied. Projects needing generated output directories require a later scoped build policy. This initial slice commits regular text files only and checks permissions, branch identity and diff integrity before commit.

Git helpers disable hooks/fsmonitor and global/system attributes; worktree creation rejects repository filters. Known environment secrets and recognizable credential patterns are redacted from persisted evidence; keep secrets out of task requests. Approval applies to the planned task; the reviewed local commit is an atomic finalization phase, during which cancellation returns a conflict. Interrupted finalization is marked failed for manual inspection and never automatically repeated.

The container is non-root, has a read-only root filesystem, dropped capabilities, resource limits, temporary `/tmp` and a data volume. These service controls alone are not a worker sandbox.

## Validation and contribution

```sh
npm run check
npm run spike:mastra
node scripts/sandbox-spike.mjs  # Requires Codex; no credentials
npm run test:m2                # Single-item fixture with real sandboxed tests/Git
npm run test:m3                # Three-item DAG, dependencies and combined review
npm run test:codex-protocol    # Real runtime/tools against a local model-protocol fixture
npm run test:docker            # Requires Docker; includes M2, M3 and runtime fixtures
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
- Interrupted work: active execution states are marked failed for inspection; automatic resumption is not implemented.

For a **live container fixture**, after starting and unlocking the service:

```sh
./devagents start
docker compose exec -T devagents node scripts/m3-smoke.mjs --live
```

It creates and removes only a temporary fixture repository and uses the running container’s unlocked credential profile. It does not register or modify your projects.

M3 live acceptance is currently blocked: two ChatGPT-authenticated attempts returned `Incomplete response returned, reason: max_output_tokens` during planning, before any implementation. Native and Docker deterministic M3 fixtures pass. The adapter supplies no output-token cap; the loopback runtime protocol check also passes. The cause of the live truncation is unresolved, so the multi-agent live workflow is not yet verified.
