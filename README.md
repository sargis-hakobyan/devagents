# DevAgents

DevAgents is an open-source, local-first AI development-team orchestrator, being built to plan, delegate, implement, test and review changes with configurable agents and replaceable coding engines.

**Current status: M2 single-engine workflow implemented; authenticated model acceptance test pending.** A dynamic Tech Lead plans one work item, a configured developer implements it in an isolated worktree, real sandboxed commands validate it, and a separate reviewer gates a local commit. Approval waits, bounded repairs, cancellation and execution evidence are persisted. Credential-free native and Docker checks are documented in [milestones](docs/MILESTONES.md), [compatibility findings](docs/M0_FINDINGS.md), and [decisions](docs/DECISIONS.md).

## Docker quickstart

```sh
./devagents start
```

The launcher builds and starts Docker, then asks for an OpenAI API key only if no credentials are saved. Paste the key at the hidden prompt and press Enter. Later runs of the same command reuse the saved credentials. No host Node.js is required. The initial build downloads dependencies and Codex. The API is at `127.0.0.1:4310`; `/health` reports readiness. The `devagents-data` volume persists state. Home directories and the Docker socket are not mounted.

For an already-cloned project, copy `examples/compose.project.yaml` to `compose.override.yaml`, set the absolute source path, then:

```sh
docker compose up -d
docker compose exec devagents node dist/cli/main.js projects add my-project /projects/my-project
```

Registration takes the **container path**. On Linux, the container's non-root UID 1000 needs access to the mount; configure ownership/ACLs rather than running as root. Native/container Git worktree paths are not interchangeable. Keep managed worktrees separate between environments. Dirty changes remain in the original checkout and are not copied into task worktrees.

To replace a saved key:

```sh
./devagents start --replace-key
```

The key is stored by Codex in `/data/engines/codex/auth.json`, a file readable/writable only by the container user (`0600`) in the persistent `devagents-data` volume. It is not encrypted. It is never added to project configuration, shell history or the image. Normal restarts and container recreation retain it; deleting the data volume removes it. An existing ChatGPT login is reused too, unless `--replace-key` is supplied. Credential storage does not confirm API credit balance or model access.

For unattended startup with credentials already configured, `docker compose up -d` remains available; it does not prompt.

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
```

Authenticate Codex before selecting a mode. Approve the version you actually reviewed. `tasks cancel TASK_ID` also rejects a pending plan. Submission with `--mode autonomous` skips the mode prompt and plan approval. Task mode overrides project default (`projects add ... --mode ...`), which overrides the global default. With no default the wait is persisted exactly once.

Reuse `--key` with identical input to retry submission without duplication. Use `tasks show` to find the managed branch, worktree path and final commit. Work runs serially in M2. Only one small implementation item is accepted; split larger requests into separate tasks. Nothing is pushed or merged automatically.

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

Codex uses a dedicated profile with ChatGPT device login or an OpenAI API key. For native interactive API-key setup (asks once, then reuses the saved profile):

```sh
npm run cli -- auth setup
# To replace the saved key:
npm run cli -- auth setup --replace-key
```

The existing explicit login methods are also available:

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

Never put literal keys in commands, YAML, commits or task requests. Login state stays in the dedicated data directory/volume; host credentials are not copied. Device login may require account/workspace enablement. Dedicated container API-key login is verified. The live model fixture was attempted but is blocked by API quota; ChatGPT device login remains unverified. A missing login fails the task with a setup error before creating a worktree; after login, submit a new task with a new retry key.

Anthropic API-key configuration is represented; its adapter is planned for M4. Third-party Claude subscription login needs an officially permitted integration, as explained in [M0 findings](docs/M0_FINDINGS.md). The container does not include Claude.

## API and security

The CLI authenticates using `<data-directory>/api-token` (mode `0600`). Keep this directory private. Only `/health` is unauthenticated. Browser-origin requests are rejected; no CORS or browser UI is enabled. This is a single-user local service.

Endpoints: `GET/POST /projects`, `GET /agents?projectId=...`, `GET/POST /tasks`, `GET /tasks/:id`, `GET /tasks/:id/events`, `GET /tasks/:id/evidence`, `POST /tasks/:id/{mode,plan,approve,cancel,run}`. Task creation requires `Idempotency-Key`; bodies use JSON. Approval includes the reviewed `version`.

The adapter pins Codex CLI 0.160.1 and builds a named permission profile from role paths. M2 supports exact paths and subtree `/**` grants; other glob forms fail closed. Read-only planning/review and writable implementation use separate processes. Shells and patches are sandboxed; tool networking, delegated agents, plugins, hooks, browser tools and web search are disabled. Runtime/user/repository configuration is ignored. Known secret files, Git metadata and existing symlinks/hardlinks are denied. Write permission also implies filesystem read access to that path.

Validation supports `node --test`, `npm test`, and `npm run test/typecheck/lint/build` in a read-only worktree with writable temporary storage. Commands cannot install dependencies over the network or write build output into the project. Install required dependencies into the managed worktree while paused at plan approval; ignored dependencies from the original checkout are not copied. Projects needing generated output directories require a later scoped build policy. This initial slice commits regular text files only and checks permissions, branch identity and diff integrity before commit.

Git helpers disable hooks/fsmonitor; worktree creation rejects repository filters. Known environment secrets and recognizable credential patterns are redacted from persisted evidence; keep secrets out of task requests. Approval applies to the planned task; the reviewed local commit is an atomic finalization phase, during which cancellation returns a conflict. Interrupted finalization is marked failed for manual inspection and never automatically repeated.

The container is non-root, has a read-only root filesystem, dropped capabilities, resource limits, temporary `/tmp` and a data volume. These service controls alone are not a worker sandbox.

## Validation and contribution

```sh
npm run check
npm run spike:mastra
node scripts/sandbox-spike.mjs  # Requires Codex; no credentials
npm run test:m2                # Deterministic engine, real sandboxed tests/Git
npm run test:codex-protocol    # Real runtime/tools against a local model-protocol fixture
npm run test:docker            # Requires Docker; includes both M2 fixtures
# Only after authenticating the dedicated native profile:
npm run test:codex-live        # Real model calls; consumes account/API usage
```

Default tests never require paid credentials. The Docker test creates/removes its own unique temporary service, volume and fixture; it does not touch registered projects. Verified on macOS ARM64 and Docker Linux ARM64. AMD64 verification is pending.

Keep contributions focused, add meaningful tests for behavioral/security boundaries, and update the decisions/checklist. Never commit local projects, secrets, login state or task databases. Licensed Apache-2.0.

## Troubleshooting and limits

- Connection refused: start the service; inspect `docker compose logs devagents` if using Docker.
- Missing API token: CLI and server must use the same data directory; run container CLI through `docker compose exec`.
- Missing authentication: run `doctor` then the dedicated login command. Startup works without credentials.
- Project registration fails: supply an absolute existing Git root with at least one commit, visible in that environment.
- Invalid agent: check capabilities, duplicate IDs and relative instruction-file paths.
- Task remains `planning` or `ready` after restart: inspect events/evidence, then explicitly queue it with `tasks run TASK_ID`. Interrupted tasks with worktree intent are marked failed; preserved approval waits require approval as usual.
- Interrupted work: active execution states are marked failed for inspection; automatic resumption is not implemented.

For a **live container fixture**, after authenticating, mount the script into a one-off Compose service using the existing dedicated data volume:

```sh
docker compose run --rm --no-deps --entrypoint node \
  -v "$PWD/scripts/m2-smoke.mjs:/app/scripts/m2-smoke.mjs:ro" \
  devagents /app/scripts/m2-smoke.mjs --live
```

It creates and removes only a temporary fixture repository; live runtime logs remain in the dedicated data directory. It does not register or modify your projects.
