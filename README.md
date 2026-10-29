# DevAgents

DevAgents is an open-source, local-first AI development-team orchestrator, being built to plan, delegate, implement, test and review changes with configurable agents and replaceable coding engines.

**Current status: runnable M1 foundation, not yet an autonomous coding system.** Register an existing checkout, configure roles/providers, submit a task, choose autonomy, store/approve a validated plan and inspect durable events. Tasks stop at `ready`. Automatic planning and real execute/test/review/commit workflows are next. See [milestones](docs/MILESTONES.md), [compatibility findings](docs/M0_FINDINGS.md), and [decisions](docs/DECISIONS.md).

## Docker quickstart

```sh
docker compose up -d
docker compose exec devagents node dist/cli/main.js doctor
```

No host Node.js or credentials are needed for startup. The initial build downloads dependencies and Codex. The API is at `127.0.0.1:4310`; `/health` reports readiness. The `devagents-data` volume persists state. Home directories and the Docker socket are not mounted.

For an already-cloned project, copy `examples/compose.project.yaml` to `compose.override.yaml`, set the absolute source path, then:

```sh
docker compose up -d
docker compose exec devagents node dist/cli/main.js projects add my-project /projects/my-project
```

Registration takes the **container path**. On Linux, the container's non-root UID 1000 needs access to the mount; configure ownership/ACLs rather than running as root. Native/container Git worktree paths are not interchangeable. Keep managed worktrees separate between environments. Dirty changes remain in the original checkout and are not copied into task worktrees.

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
npm run cli -- tasks plan TASK_ID examples/plan.yaml
npm run cli -- tasks show TASK_ID
npm run cli -- tasks approve TASK_ID --version 2
npm run cli -- tasks events TASK_ID
```

Approve the version you actually reviewed. The example plan's project ID is `my-project`; adjust it if needed. `tasks cancel TASK_ID` also rejects a pending plan. Submission with `--mode autonomous` skips the mode prompt and plan approval. Task mode overrides project default (`projects add ... --mode ...`), which overrides the global default. With no default the wait is persisted exactly once.

Reuse `--key` with identical input to retry submission without duplication. Plans are supplied manually in M1; the dynamic Tech Lead is not wired yet.

## Configuration and agents

`DEVAGENTS_DATA_DIR` defaults to `.devagents`, and `DEVAGENTS_PORT` to `4310`. Set `DEVAGENTS_CONFIG` to a YAML file such as `examples/devagents.yaml`. The native process does not automatically load `.env`; `.env.example` documents variables. Compose uses `.env` for substitution only.

Six built-ins: Tech Lead, Developer, Backend Developer, Frontend Developer, QA Engineer and Code Reviewer. Add YAML and Markdown under `<data-directory>/agents/` or `<project>/.devagents/agents/`. Precedence is project > user > bundled `agents/builtin/`. Duplicate IDs within a directory fail validation. Definitions reload when the registry is requested; M2 will snapshot them for running tasks.

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

Codex uses a dedicated profile with ChatGPT device login or an OpenAI API key:

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

Never put literal keys in commands, YAML, commits or task requests. Login state stays in the dedicated data directory/volume; host credentials are not copied. Device login may require account/workspace enablement. Successful account login is still an unverified M0 gate.

Anthropic API-key configuration is represented; its adapter is planned for M4. Third-party Claude subscription login needs an officially permitted integration, as explained in [M0 findings](docs/M0_FINDINGS.md). The M1 container does not include Claude.

## API and security

The CLI authenticates using `<data-directory>/api-token` (mode `0600`). Keep this directory private. Only `/health` is unauthenticated. Browser-origin requests are rejected; no CORS or browser UI is enabled. This is a single-user local service.

Endpoints: `GET/POST /projects`, `GET /agents?projectId=...`, `GET/POST /tasks`, `GET /tasks/:id`, `GET /tasks/:id/events`, `POST /tasks/:id/{mode,plan,approve,cancel}`. Task creation requires `Idempotency-Key`; bodies use JSON. Approval includes the reviewed `version`.

Scoped paths reject traversal/symlinks. Initial policy helpers deny credential/runtime paths, commands without a verified sandbox, and push/merge/deploy. Git helpers disable hooks/fsmonitor; worktree creation rejects checkout filters. Known environment secrets and recognizable credential patterns are redacted from logs/task payloads; keep secrets out of requests regardless. Full engine-tool enforcement remains an M2 gate, so coding execution is disabled.

The container is non-root, has a read-only root filesystem, dropped capabilities, resource limits, temporary `/tmp` and a data volume. These service controls alone are not a worker sandbox.

## Validation and contribution

```sh
npm run check
npm run spike:mastra
node scripts/sandbox-spike.mjs  # Requires Codex; no credentials
npm run test:docker            # Requires Docker
```

Default tests never require paid credentials. The Docker test creates/removes its own unique temporary service, volume and fixture; it does not touch registered projects. Verified on macOS ARM64 and Docker Linux ARM64. AMD64 verification is pending.

Keep contributions focused, add meaningful tests for behavioral/security boundaries, and update the decisions/checklist. Never commit local projects, secrets, login state or task databases. Licensed Apache-2.0.

## Troubleshooting and limits

- Connection refused: start the service; inspect `docker compose logs devagents` if using Docker.
- Missing API token: CLI and server must use the same data directory; run container CLI through `docker compose exec`.
- Missing authentication: run `doctor` then the dedicated login command. Startup works without credentials.
- Project registration fails: supply an absolute existing Git root with at least one commit, visible in that environment.
- Invalid agent: check capabilities, duplicate IDs and relative instruction-file paths.
- Task remains `planning` or `ready`: expected in M1. Supply a plan manually to exercise approval. Execution is the next increment.
- Interrupted work: active execution states are marked failed for inspection; automatic resumption is not implemented.
