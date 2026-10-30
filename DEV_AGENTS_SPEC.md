# DevAgents — Product and Engineering Specification

Status: implementation in progress, v0.1 (decisions updated 2026-10-30)

> DevAgents is a local-first, open-source, configurable AI software development team. It dynamically plans and delegates user requests to specialized agents, executes work with replaceable coding engines, validates results, and prepares reviewable Git changes.

## 1. Decisions and assumptions

### Confirmed in design discussions

- Public GitHub source repository; anybody should be able to clone and run their own instance locally.
- Local execution of orchestration and coding-agent runtimes. OpenAI/Anthropic cloud inference first; local LLM support is a planned follow-up phase. Provider/model configuration must be extensible from the start.
- Docker-first, one-command startup goal; native Node.js development remains supported. Docker must not be mandatory.
- Dynamic AI Tech Lead: inspect requirements, discover available specialists, decompose tasks, build dependencies, delegate parallelizable tasks, and adapt after failures.
- Configurable agent registry: users can add, remove, enable, or customize roles (e.g. Graphic Designer) without editing orchestration source.
- Replaceable coding engines; implement Codex first, then Claude Code. Separate inference providers from coding runtimes; each agent can select its own provider/model. Offer API-key and officially supported login authentication, with provider-specific availability clearly reported. Avoid vendor-specific agent definitions in the domain layer.
- Per-task autonomy mode: if the request doesn't specify it, the Tech Lead asks whether to run fully autonomously or request plan approval. Do not ask again if explicitly specified.
- Automated implementation, testing, review, repair loops, Git commits and optional GitHub PR preparation.
- Local persistence and recovery of tasks, plans, decisions, status and execution history.
- Project-scoped filesystem permissions, secret redaction and safe Git practices.

### Proposed, subject to validation during implementation

- Final project name: **DevAgents**; repository name `devagents`.
- TypeScript/Node.js application; **Mastra** as an initial candidate for agent/workflow orchestration. Keep domain logic framework-independent so replacing it with LangGraph or another orchestrator remains feasible.
- SQLite for single-user persistence; optional PostgreSQL later.
- Initial implementation uses CLI/API. A local browser dashboard is now approved in U1–U3: visibility, saved teams/member editing, then browser task workflows and guided setup. See `docs/FRONTEND_BRIEF.md`; Claude will design and implement it. The CLI remains supported. Mastra Studio is not a prerequisite for this UI.
- Git worktrees for task isolation; development on macOS/Linux initially and Docker multi-arch (`linux/amd64`, `linux/arm64`).
- One Tech Lead coordinating flat specialist agents in v0.1. Keep delegation schema extensible for nested team hierarchies later.
- PR creation is allowed only when explicitly configured and authorized; merging/deploying and protected-branch writes are out of default scope.

### Open product decisions — do not silently assume

1. Repository owner resolved: `sargis-hakobyan/devagents`; public source, Apache-2.0.
2. Workspace strategy resolved: users supply the absolute path of an existing local Git checkout. Do not clone or import it. Native execution registers that directory; Docker requires an explicit mount of that project. Preserve dirty user work and create managed task worktrees.
3. Authentication pathways supported by the installed Codex and Claude Code runtimes inside Docker; verify official supported login options. Do **not** assume host CLI credentials are portable to containers.
4. What constitutes permitted autonomous `git push`: default should be off until the user enables it for a repository.
5. Whether reviewer must use a different engine from implementer; recommended optional policy, not mandatory.

## 2. Product experience

### First-run goals

On a clone, `docker compose up -d` should start DevAgents, without requiring host Node.js. The UI/CLI must explain any missing setup, model-engine auth, workspace registration, or GitHub permission. A first-run interactive step may still be necessary; **one command to start does not mean zero authentication/configuration**.

Support a published prebuilt container image as an optional later improvement, reducing build time. Native path: `npm install && npm run dev` after copying example configuration.

Users register one or more project roots, select available coding engines, set agent definitions and optional default policy. GitHub is optional for purely local development.

### Task flow

1. Developer submits request, project ID, optional autonomy mode, constraints and acceptance criteria.
2. If autonomy mode missing, Tech Lead asks exactly once for **fully autonomous** or **plan approval**; suspend execution awaiting response. An explicit per-task setting overrides a project default if one is configured; for MVP, still ask when neither is set.
3. Tech Lead probes project context within allowed root, identifies uncertainty and asks only blocking domain questions; does not manufacture requirements.
4. Tech Lead produces typed plan: deliverables, agents/capabilities, task DAG, dependencies, worktree/file ownership, risks, validation commands and definition of done.
5. In plan-approval mode, show plan and await explicit approval. In autonomous mode, proceed within permission boundaries.
6. Schedule ready tasks, select compatible agents/engines, create isolated task worktrees and run workers with bounded concurrency.
7. Run targeted checks, integrate independent outputs, resolve conflicts through explicit integration task; execute project-wide checks.
8. Reviewer evaluates diff independently against requirements and tests. Failures become bounded repair tasks; do not allow endless implement-review cycles.
9. Present final summary, evidence, test outcomes, files, commits, and any limitations. Create PR if repository integration is configured and user/policy permits.
10. Never silently merge, deploy, push to protected branches, delete user work, or exfiltrate secrets.

### Agent selection

The Tech Lead sees agent metadata from registry (description, declared capabilities, supported engine, permissions, status, concurrency constraints). Select minimal useful team for a task. Specialized roles are optional, not hardcoded. If a required capability is missing, explain the gap and offer an allowed generalist or request installation; don't assume a new external tool exists.

### Browser dashboard and reusable teams (approved 2026-10-30)

Provide Overview, Teams, Projects, Tasks and Settings views. Saved teams contain configurable named members and can be reused across projects; a project may set a default team. Snapshot the selected team revision and resolved member configuration at submission so edits cannot change queued or active tasks. Preserve legacy YAML/Markdown configuration and task history. The UI displays actual execution state, approvals, tests, review and local Git outcomes. Multiple teams do not expand the current single-active-request scheduler.

`docs/FRONTEND_BRIEF.md` defines the detailed UX, backend/data changes, browser security requirements and U1–U3 acceptance criteria. The browser uses a protected local session; it must not expose the CLI bearer token or remove origin protections without a tested replacement. Same-origin static assets ship with the existing service and Docker image. Browser-based credential setup may initially guide the existing secure terminal flow.

## 3. Architecture and boundaries

```text
CLI / API / future UI
        |
Task service + durable state (framework-independent domain)
        |
Dynamic Tech Lead (Mastra adapter) --- Agent Registry / Policy Engine
        |
Planner / Scheduler (task DAG, concurrency, ownership, retries)
        |
CodingEngine interface ------ CodexAdapter / ClaudeCodeAdapter
        |
Execution sandbox / task-scoped Git worktree
        |
Validators -> Review -> Repair -> local commit -> optional push/PR
```

Make these interfaces independent of Mastra:

- `AgentRegistry`: load, validate and resolve definitions and capabilities.
- `TaskRepository`: persist tasks, plans, events, approvals, runs and outcomes.
- `PlanService` / `Scheduler`: validate DAG, dependencies, concurrency limits, cancellation and failure policy.
- `CodingEngine`: start/resume (when supported), stream events, cancel, report results, capabilities and health. Engine adapter must normalize errors and events.
- `WorkspaceManager`: validate project roots, create/clean owned worktrees, branch naming, file ownership and integration.
- `PolicyEngine`: enforce permissions independently of prompts, including per-tool/command/file/network actions.
- `ReviewService`: check evidence and produce actionable findings, not just agent self-assessment.
- `GitProvider`: optional GitHub integration; local Git operations work without GitHub.

**Important:** A model API call is not the same as a complete coding runtime. Mastra can coordinate agents, but it must not be assumed to provide Codex/Claude Code execution semantics. Implement SDK/CLI adapters against the current officially supported surfaces.

## 4. Agent configuration system

Built-in templates live in `agents/builtin/`; user project overrides in `<project>/.devagents/agents/`; user-wide additions in persisted DevAgents config. Establish deterministic precedence: project > user > built-in. Never implicitly execute scripts from untrusted agent packages.

Illustrative config (final schema to be validated with Zod):

```yaml
schemaVersion: 1
id: graphic-designer
name: Graphic Designer
description: Produces visual concepts and checked-in design assets
enabled: true
engine: claude-code # codex | claude-code | default
model: default
capabilities: [asset-design, filesystem-read, filesystem-write]
instructionsFile: ./instructions.md
delegation:
  canReceiveTasks: true
  canDelegate: false
permissions:
  readPaths: ["project:/**"]
  writePaths: ["project:/assets/**", "project:/design/**"]
  allowCommands: false
  allowPush: false
```

The strings are DevAgents-defined capabilities, not guarantees that an image-generation tool is installed. A capability registry maps each capability to a real tool/backend and validates availability. For `asset-design`, a suitable generator or design integration must actually be configured; otherwise report missing capability.

Provide built-in templates: `tech-lead`, `general-developer`, `backend-developer`, `frontend-developer`, `qa-engineer`, `code-reviewer`; optional examples `security-engineer`, `graphic-designer`, `technical-writer`.

Agent definition supports: ID, user-facing name, description, instruction file, engine, provider and model selection, tool/capability allowlist, permissions, delegation rights, concurrency and enabled state. Validate duplicate IDs, path traversal, unknown tools, invalid engine, cycles in delegation policies and forbidden permissions. Reload registry explicitly or with safe file watching; don't replace definitions mid-running task silently.

## 5. Orchestration state model

Suggested task states: `draft`, `awaiting_mode`, `planning`, `awaiting_plan_approval`, `ready`, `running`, `validating`, `reviewing`, `repairing`, `awaiting_external_approval`, `completed`, `failed`, `cancelled`.

Persist an append-only event history and derived current status. Every transition records run ID, timestamp, actor, task ID and reason. Critical operations use idempotency keys. A restart must reconcile orphaned tasks and worktrees; do not blindly re-run already completed `git push` or PR calls.

Plan is a validated DAG; each work item defines `id`, `title`, `description`, `acceptanceCriteria`, `dependsOn`, `requiredCapabilities`, `projectId`, `branch`, `validation`, and optional `assignedAgent`. Only schedule when dependencies are satisfied. Bound retries per work item and repair cycles; surface irrecoverable failures clearly.

State survives process and container restarts through a persistent volume. Resume from checkpoints where possible; otherwise reconcile filesystem/Git and safely re-launch with explicit logs. Tasks must be cancellable; cancellation stops children and releases scheduler slots.

## 6. Coding-engine portability

```typescript
type EngineId = 'codex' | 'claude-code';
interface CodingEngine {
  readonly id: EngineId;
  capabilities(): Promise<EngineCapabilities>;
  execute(input: ExecutionRequest, hooks: ExecutionHooks): Promise<ExecutionResult>;
  cancel(runId: string): Promise<void>;
}
```

`ExecutionRequest` includes task/plan context, allowed project/worktree path, relevant files, constraints, model preference, time/tool budgets and scoped permission policy. `ExecutionResult` includes status, touched files, commit/diff reference, stdout/test evidence references, warnings, usage/cost when available and error class. Stream normalized progress/telemetry events.

Implement one engine first end-to-end, then the second with the same contract. Per-agent engine selection is configurable; simultaneous different engines are supported conceptually, but v0.1 can serialize integration operations and limit worker concurrency. Explicitly test engine absence/auth failures, timeout, cancellation, CLI version changes and malformed outputs. No provider-specific agent syntax in project-level agent schema.

## 7. Workspaces, Git and integration

- No root-home mount and no Docker socket mount by default.
- Register only explicitly approved host project directories; validate canonical paths and symlinks.
- In Docker, mount each existing local project explicitly through Compose configuration, alongside a separate persistent data volume. Do not clone/import projects or mount the user home.
- Every concurrent implementation task gets its own managed worktree and branch; never let two workers modify the same worktree concurrently.
- Record base SHA and detect divergence before integration; support straightforward merges and escalate conflicting architectural choices.
- Never reset, force push, discard user changes, or delete unmanaged worktrees automatically.
- A reviewer gets the requested diff, test evidence, and acceptance criteria with read-only permissions by default.
- GitHub integration uses least-privilege credentials and opens PRs from explicit user-approved branches; CI status is verified if available. GitHub must be optional.

## 8. Security and approvals

Autonomy is **not** unrestricted tool access. The policy engine, outside the model, authorizes file writes, shell commands, networking, Git operations and secret access. Defaults: only registered projects; no arbitrary host paths; no production infrastructure access; no shell execution for non-coding design-only agents; no protected branch pushes; no merges or deployments.

Use command allowlists/deny rules plus per-command context checks. Treat `curl | sh`, destructive commands, shell redirection and arbitrary tool install as high-risk; don't rely on textual denylisting alone. Sandbox worker execution appropriately, prefer non-root container user, scoped filesystem mounts, constrained network, resource/time limits and explicit escalation flow. Never put secrets into model prompts, logs or source control. Provide redaction and secure secret injection.

Automation modes:

| Mode | Planning | Execution | External effects |
| --- | --- | --- | --- |
| `autonomous` | AI decides and starts | Runs within defined policy | Push/PR only if independently permitted |
| `plan-approval` | AI presents plan and waits | Autonomous after approval | Same independent permissions |

If neither task input nor configured default states a mode, ask the developer and persist choice for this task. For ambiguous requirements, ask blocking questions regardless of mode. Approval for a plan is not permission for unrestricted pushes, merges, deployments or destructive commands.

## 9. Docker and setup

Design for `docker compose up -d` after `git clone`. Include `compose.yaml`, `Dockerfile`, `.dockerignore`, `.env.example`, initial configuration and a documented first-run path. Bind the web service to `127.0.0.1` by default. Data persists across container recreation. Container image includes verified compatible Node.js, Git and coding-engine runtimes (or clearly explained supported engine sidecars). Avoid embedding authentication or distributing user credentials in image layers.

Docker authentication is an explicit **technical spike**: validate official authentication flows for both coding engines in headless/container contexts. Prefer first-party SDKs and documented token mount conventions; do not copy private credential directories by default. If a login cannot be securely completed in-container, provide a clearly documented alternative. Native run should use the same config/schema.

Healthchecks, logs, error messages, setup instructions, graceful shutdown, non-root execution and CPU/RAM/concurrency limits are required. Build images for ARM64 and AMD64 in CI after functionality is validated. Docker daemon need not be available inside the agent container.

## 10. Proposed repository layout

```text
devagents/
  README.md
  LICENSE                          # Apache-2.0
  compose.yaml
  Dockerfile
  .dockerignore
  .env.example
  package.json
  src/
    domain/                        # framework-independent types, state, policy
    orchestration/                 # Mastra integration + scheduler
    agents/                        # registry and validation
    engines/codex/
    engines/claude-code/
    workspace/
    git/
    persistence/
    api/
    cli/
    telemetry/
  agents/builtin/
  examples/
    agent-graphic-designer/
    sample-project-config/
  tests/unit/
  tests/integration/
  tests/e2e/
  docs/
```

## 11. Definition of done for MVP

1. On supported Mac/Linux host, clean checkout starts via Docker Compose; startup reports missing engine auth or workspace configuration without crashing in a loop.
2. A user can register a Git project and submit a task through CLI/API.
3. Missing autonomy mode triggers a blocking choice; explicit mode skips it. Plan-approval waits for approval and can be rejected/cancelled.
4. A dynamic Tech Lead discovers agents from registry, generates a validated plan DAG, and delegates ready tasks with bounded concurrency.
5. Two user-defined roles can be added purely by YAML/Markdown; invalid tool or permission references are rejected.
6. Both Codex and Claude Code adapters are implemented and independently demonstrated against the same small fixture repository, with mocked adapters for most automated tests.
7. Git worktrees prevent concurrent file editing collisions; existing dirty user work is not overwritten.
8. Successful workflow runs actual tests, independent review, bounded repair, and creates a local commit on a non-protected branch.
9. With explicit GitHub authorization, creates a PR; without it, works offline/local and gives branch/commit details.
10. State and event history survive restart; recovery never duplicates external GitHub actions.
11. Secrets are redacted; unapproved host access and destructive operations are blocked in integration tests.
12. README includes quickstart, security model, engine setup, agent customization, limitations, troubleshooting and contribution guide.

## 12. Implementation milestones and order

**M0 — Technical spikes:** verify current Codex/Claude integration APIs and container auth; verify minimal Mastra workflow + persistence; validate supported platforms. Document results before locking architecture.

**M1 — Foundation:** Node/TS project, domain model, Zod schemas, SQLite migrations, event log, CLI/API, config loading, Docker Compose, tests.

**M2 — Single-engine vertical slice:** one coding engine, dynamic Tech Lead, plan approval, one worktree, execute/test/review, local commit, observable status.

**M3 — Dynamic multi-agent:** registry and user roles, DAG scheduler, bounded parallel tasks, isolated worktrees, integration/review/repair loop.

**U1–U3 — Local browser UI (approved addition):** U1 introduces secure browser access and read-only visibility; U2 adds saved teams, member editing and revisioned snapshots; U3 adds project/task workflows and guided setup. Design the full flow, implement U1 as the first integrated increment before M4, then deliver subsequent UI increments separately. See `docs/FRONTEND_BRIEF.md`. Design and deterministic development can proceed while post-review live acceptance remains pending; neither this milestone nor the design handoff authorizes authenticated model calls.

**M4 — Engine portability:** second engine adapter, per-agent engine selection, normalized telemetry/cancellation/failure handling, cross-engine fixture tests.

**M5 — Public release:** GitHub PR integration, recovery hardening, least-privilege policies, multi-arch Docker CI, documentation, example agents and release assets.

**Follow-up phase — Local models:** add and demonstrate local inference providers (for example Ollama or an OpenAI-compatible endpoint) using the same model configuration and a compatible tool-execution harness. Do not equate a model endpoint with a coding engine.

Implement in small reviewed increments. The approved U1–U3 dashboard supersedes the earlier custom-UI deferral. Preserve core acceptance gates, record pending post-review live reruns, and keep M4 deferred until acceptance is established. Nested team hierarchy remains out of scope.

## 13. Test strategy

- Unit: schema parsing, configuration precedence, DAG validation/cycle detection, scheduler dependencies, permission decisions, lifecycle transitions, engine error normalization.
- Integration: fake engines for orchestration, temporary Git fixture for worktrees and branches, SQLite crash/restart, conflict handling, missing auth, rejected plans, bounded retries, cancellation.
- Contract: run same fixture with both real engines when credentials available. Never require paid API credentials for default `npm test`.
- Docker smoke: clean compose up, healthcheck, persistent volume restart, agent registration, bind-mount scoping, no secrets in logs.
- Security: path traversal, symlink escape, malicious instructions in repo files, unauthorized push/merge, shell escape, accidental secret exposure.

## 14. Non-goals for v0.1

Local model execution is deferred to a follow-up phase, with provider seams designed now. Other non-goals: production deployment, automatic merges, arbitrary external-system access, hosted multi-tenant service, marketplace/plugin code execution, nested organizational hierarchies, automatic image-generation integration, dashboards beyond the focused U1–U3 brief, native mobile clients.

## 15. Guidance for an implementing coding agent

Read this entire document and `IMPLEMENTATION_PROMPT.md`. Begin with M0 technical spikes and a concise executable plan. Preserve undecided items as explicit assumptions or ask blocking questions. Build a **working vertical slice first**, not an expansive scaffold. Keep interfaces framework-independent and use real tests. Do not claim engine compatibility or Docker one-command onboarding until independently demonstrated. Never commit API keys, login state or local user projects.
