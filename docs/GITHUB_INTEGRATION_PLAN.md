# GitHub integration plan

Status: **proposal**. One part exists outside this plan: a per-project GitHub token can be connected and checked (see "Project integrations" in `docs/REFERENCE.md`); nothing below is implemented. Written 2026-11-12. Design boards: `design/ui/U7-GitHub-*.dc.html` (row U7 on the design canvas). This plan covers milestone M5's "authorized GitHub integration" in `docs/MILESTONES.md`.

## Goal

DevAgents can attach GitHub repositories, push a completed task's branch, open a pull request, read review comments and check results, run follow-up work that addresses them, push again, and repeat until the pull request is green. A human merges.

Projects that are not linked to GitHub behave exactly as today: a task ends in one reviewed local commit and a read-only diff, and nothing leaves the machine.

## Owner decisions (2026-11-12)

| Question | Decision |
| --- | --- |
| Several repositories | One repository per project. Many projects can be GitHub projects. A task works in one repository and belongs to at most one pull request. |
| How a repository gets in | Both: link an existing local project to its GitHub repository, or add a repository by name and let DevAgents keep a managed clone. |
| Autonomy | Per-project policy. Every action defaults to "on click". A project may allow automatic pull requests and automatic follow-up rounds, with a limit. |
| Authentication | A personal access token per account or organization, stored in the credential vault. A GitHub App is not in scope. |
| Where an account is connected (2026-11-13) | In the "Add project" flow, not in Settings first. Adding a project asks one question, local folder or GitHub repository; a GitHub project picks a connected account or pastes a token inline. The token is stored once per account and shared by that account's projects, so different projects can use different accounts and an expiring token is replaced once. Settings only lists accounts to replace or remove a token. |

## What does not change

- The task lifecycle in `src/domain/lifecycle.ts`. `completed`, `failed` and `cancelled` stay terminal. Publishing is not a task state.
- Agents. `Permissions.allowPush` stays `z.literal(false)`; the sandbox keeps denying Git metadata and the credential runtime. Only the service talks to GitHub.
- Worktree isolation, frozen team snapshots, version-bound approvals, bounded repair loops, evidence, the diff contract (`GET /tasks/:id/diff`) and cleanup.
- The user's checkout: no merge, no checkout, no change to its branches, remotes or config.

## What changes in the product rules

`AGENTS.md`, `README.md`, `docs/DECISIONS.md` and `docs/REFERENCE.md` say DevAgents never pushes. The new rule, to be recorded in `docs/DECISIONS.md` before code lands:

- DevAgents pushes **only branches named `devagents/…`**, **only to the repository linked to the project**, and only after an explicit click or under the project's saved policy.
- DevAgents **never** merges, force-pushes, pushes to the default branch, deletes remote branches, or re-runs or cancels workflows.

## Concept

### Vocabulary

| Term | Meaning |
| --- | --- |
| **Connection** | One GitHub token for one account or organization, with a lowercase id (`example-org`). Stored in the vault. |
| **Project source** | `local` (today), `linked` (local folder plus a GitHub repository) or `managed` (a clone DevAgents owns under `<dataDir>/repos/<id>`). |
| **Policy** | Per-project choices: open the pull request on click or automatically; start rounds for review comments and for failed checks on click or automatically; the automatic-round limit; whose comments count; where work starts; whether to reply on threads. |
| **Pull request** | A record linking one GitHub pull request to the tasks that produced its commits. |
| **Round** | One task that contributes one commit to a pull request. Round 1 is the original task. Later rounds address review comments, failed checks, or conflicts with the base branch. |
| **Operation** | One recorded external effect (clone, fetch, push, open pull request, reply). Written before it runs, reconciled against GitHub before any retry. |

### A round is a normal task

This is the central choice. A follow-up round is an ordinary `Task` with one extra field that says which pull request it belongs to and what it must address. It goes through the same workflow: mode gate, plan, approval, build, validation, optional QA, independent review, one local commit.

Consequences:

- No new execution engine, no change to terminal states, and every round has its own plan, evidence, usage and diff.
- A round's worktree starts from the **pull request's latest commit on GitHub**, not from `main`. If someone else pushed to the branch, the round builds on their commit.
- A round keeps its **own local task branch** (`devagents/<slug>-<roundTaskId8>`), so branch ownership, the diff checks and cleanup need no change. Publishing a round pushes its commit to the pull request's branch on GitHub as a fast-forward: `git push <url> <roundCommit>:refs/heads/<prBranch>`.
- The round's diff shows exactly what that round changed.

### Flow

1. A task completes. Local result and diff are available as today.
2. **Publish** (click, or automatic by policy): fetch, push the task branch, open the pull request, run a first sync.
3. **Sync** (polling, about every 60 s per open pull request): state, review decision, review threads, checks for the latest commit, mergeability.
4. **Round** (click, or automatic by policy): compose a task from the selected threads and failed checks, run it, push its commit, reply on the addressed threads.
5. Repeat 3 and 4 until checks pass and the review is approved. The human merges on GitHub; sync then records "merged" and stops.

Polling is used because DevAgents is a local service with no public address for webhooks.

## Architecture

### New module `src/github/`

| File | Responsibility |
| --- | --- |
| `client.ts` | GitHub REST and GraphQL over `fetch`. Base URL configurable (default `https://api.github.com`) so tests can point it at a fixture. Conditional requests with ETags. Typed errors for 401, 403, 404, 422, rate limit. No `gh` binary. |
| `remote.ts` | `fetch`, `push`, `ls-remote`, `clone` through the existing `git()` wrapper in `src/workspace/git.ts`. |
| `operations.ts` | The operation outbox and its reconciliation rules. |
| `sync.ts` | The poller and the stored pull-request snapshot. |
| `rounds.ts` | Builds a round's task request from selected threads and failed checks; decides automatic rounds from policy. |
| `description.ts` | Builds the pull-request body from recorded evidence (plan summary, validation commands and exit codes, review verdict, limitations). |

Keep these independent of Mastra, like the other domain and workspace contracts.

### Git transport

- Always HTTPS to a URL the service builds from the stored `owner/repo`. The remote URL configured in a user's checkout is read once to suggest a link and never used for transport. This avoids SSH, which the image does not have.
- The token is passed through environment-based Git configuration (`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_0=http.https://github.com/.extraheader`, `GIT_CONFIG_VALUE_0=…`). It is never on a command line, never written to a Git config file, and never in a URL.
- Explicit refspecs only. Fetched commits go under DevAgents-owned refs (`refs/devagents/remote/<branch>`, `refs/devagents/pr/<id>/head`), so a linked checkout's `refs/remotes/origin/*` are untouched.
- Pushes are plain (no `--force`, no `--force-with-lease`). Before the first push, `ls-remote` checks that the branch name is free or already at the task's commit.
- `git()` has a 30 s default timeout; network operations pass a longer timeout and the abort signal.

### Domain (`src/domain/schemas.ts`)

```ts
GitHubLink   = { connectionId: Id, owner: string, repo: string, defaultBranch: string }
GitHubPolicy = {
  openPullRequest: 'manual' | 'auto', draft: boolean,
  reviewComments: 'manual' | 'auto', failedChecks: 'manual' | 'auto',
  maxAutoRounds: number /* 1–5, default 3 */,
  commentAuthors: 'me' | 'write-access',
  startFrom: 'local-main' | 'remote-default',
  replyOnThreads: boolean,
}
Project += { source: 'local' | 'managed', github?: GitHubLink, githubPolicy?: GitHubPolicy }
Task    += { followUp?: { pullRequestId, round, kind: 'review' | 'checks' | 'mixed' | 'update-base',
                          baseSha, threadIds: string[], checkIds: string[], trigger: 'user' | 'policy' },
             githubPolicy?: GitHubPolicy /* frozen at submission */ }
```

`ProjectInput` stays strict; the GitHub variant is a second strict shape (`{ id, source: { connectionId, repository } }`), not optional fields on the local one.

### Persistence (`src/persistence/store.ts`, migration v7)

- `github_connections(id PK, data JSON)`: login, owner, token kind, expiry, permissions found, last verification. **No secret.**
- `pull_requests(id PK, project_id, number, head_branch, base_branch, state, head_sha, auto_rounds_used, snapshot JSON, etag JSON, synced_at, version)`.
- `pull_request_rounds(pull_request_id, round, task_id UNIQUE, kind, commit, pushed_at)`.
- `github_operations(id PK, project_id, pull_request_id, task_id, kind, state, intent JSON, result JSON, attempts, created_at, updated_at)` with states `pending | running | done | failed | unknown`.
- Project fields continue to live in the project's JSON `data`, updated under the existing optimistic `version`.
- Publishing also appends task evidence (`github-push-intent`, `github-pushed`, `github-pr-opened`, `github-reply`) so the Activity tab shows it without a new log.

### Credentials (`src/security/credential-vault.ts`)

- `CredentialVault` takes an engine union `'codex' | 'claude'`. Generalize the name to a validated string and add entries `github-<connectionId>` (`<dataDir>/credentials/github-<id>.enc`, AAD `devagents/github-<id>-credentials/v1`). `cli auth unlock` unlocks them with the same master key.
- Native installs have no generic secret store today (Codex uses its own keyring; Claude falls back to environment variables). First increment: environment variable `DEVAGENTS_GITHUB_TOKEN_<ID>`, mirroring the Claude fallback. Decide in G1 whether to make the vault usable natively instead.
- Add each token value to `Store.secrets` so the existing redaction covers prompts, events, evidence, API output and diffs. `src/telemetry/redact.ts` already matches `gh*_` and `github_pat_` shapes.

### Workspace (`src/workspace/`)

- `mainCommit()` hard-codes `refs/heads/main`. Replace it with a base resolver that takes the project and an optional round:
  - local project, or linked with `startFrom: 'local-main'`: `refs/heads/main`, unchanged, including the `main_branch_missing` error;
  - linked with `startFrom: 'remote-default'`, and managed: fetch, then `refs/devagents/remote/<defaultBranch>`;
  - a round: fetch the pull request's branch, then `refs/devagents/pr/<id>/head`.
- A managed clone is a bare repository DevAgents owns. `inspectProject()` requires a work tree and `commitChanges()` compares the user's checkout `HEAD` with `originalHead`; both checks are skipped for `source: 'managed'`, where there is no user checkout. Confirm in the G0 spike that `git worktree add` and `readTaskDiff` behave on a bare repository.
- `readTaskDiff` is unchanged: a round's `baseSha` is the pull request's head at round start and its final commit is on the round's own branch.

### Orchestration

- `TaskService.publish(taskId, input)`, `startRound(pullRequestId, input)`, `pushRound(taskId)`, `syncPullRequest(id)`.
- A `GitHubWorker` runs on the `TaskRunner`'s existing one-second tick: it executes pending operations (one at a time per repository, under `lockRepository`), syncs due pull requests, and evaluates policy. It does not take a task-concurrency slot; rounds it creates are queued through `requestDispatch` like any task.
- Round creation reuses the idempotency table (`requests`) with a key derived from pull request, head commit, kind and selected inputs, so a restart or a second sync cannot create the same round twice.
- Automatic rounds run in `autonomous` mode. Manual rounds use the project's default mode. Rounds reuse the frozen team of round 1 unless the user picks another.

### Automatic policy, evaluated after each sync

In order; the first match wins:

1. A round is running, or checks are still in progress: do nothing.
2. A round that was started by policy finished locally: push it, then reply on threads. (A round started by a click is pushed by a click unless the same kind is set to automatic.)
3. `auto_rounds_used >= maxAutoRounds`: mark "needs you".
4. Checks finished with failures, `failedChecks: 'auto'`, and no round was already started for this head commit and failure set: start a round.
5. A review was submitted with unresolved threads from allowed authors since the last round, `reviewComments: 'auto'`: start a round.

A failed or cancelled automatic round counts toward the limit.

### Reconciliation of uncertain outcomes

Before any retry, ask GitHub what exists:

| Operation | Check |
| --- | --- |
| push | `ls-remote` the branch; equal to the intended commit means done |
| open pull request | list pull requests for the head branch, any state |
| reply | each reply body carries a hidden marker with the operation id; look for it in the thread |
| clone | remove the incomplete directory and start again |

An operation that cannot be reconciled stays `unknown` and is shown to the user; it is never repeated blindly (`DEV_AGENTS_SPEC.md` restart rule).

### Security

- **Review comments and CI logs are untrusted input.** They are fenced as quoted material in the round's request, capped (log tail of the failed step, 64 KiB), and redacted before storage.
- Only comments by allowed authors are selected by default or used by automatic rounds: the connected login, or accounts whose `authorAssociation` is `OWNER`, `MEMBER` or `COLLABORATOR`. Others are shown and can be ticked by hand.
- Agents never receive the token and cannot push. The independent reviewer still reviews every round, and a human merges.
- A round that changes files under `.github/workflows/` is not pushed automatically, whatever the policy: a changed workflow runs with the repository's CI secrets. Recommend tokens without the Workflows permission.
- Repositories are chosen from the list the token can reach, never typed as a URL. The API host is fixed by configuration.

### API (`src/api/server.ts`)

| Route | Purpose |
| --- | --- |
| `GET /github/connections`, `POST /github/connections`, `POST /github/connections/:id/verify`, `DELETE /github/connections/:id` | Connection management; the token is write-only |
| `GET /github/connections/:id/repositories` | Repositories the token can reach |
| `POST /projects` (GitHub variant) | Clone and register a managed project |
| `PUT /projects/:id/github` | Link, unlink and save policy under `expectedVersion` |
| `GET /tasks/:id/pull-request` | Pull request, rounds and last snapshot for any round's task |
| `POST /tasks/:id/publish` | Push and optionally open the pull request; `Idempotency-Key` required |
| `POST /pull-requests/:id/sync` | Sync now |
| `POST /pull-requests/:id/rounds` | Start a round from selected threads and checks; `Idempotency-Key` required |
| `POST /tasks/:id/push-round` | Push a round that finished locally |
| `GET /overview` | Attention items gain pull requests and expiring tokens |

All mutations keep the existing bearer or session-plus-CSRF rules.

### CLI (`src/cli/main.ts`)

`github connect [id]` (hidden prompt via `secret-prompt.ts`; the id defaults to the account GitHub reports for the token, and the browser form has no name field), `github connections`, `github verify <id>`, `projects add-github <id> <owner/repo> --connection <id>`, `projects link <id> --connection <id>`, `projects policy <id> …`, `tasks publish <id>`, `pr show|sync|round <task>`.

### UI (`ui/src/`)

No new navigation entry. Boards in `design/ui/`:

| Board | Screen |
| --- | --- |
| `U7-GitHub-Connect` | Settings, housekeeping only: connected accounts as single rows with a "Manage" menu and folded details, the empty state pointing to "Add project", three problem states |
| `U7-GitHub-Projects` | Projects: one row per project, "Add project" with the local-or-GitHub question and the inline token for a new account, "Link to GitHub", autonomy presets with a folded fine-tune, three problem states |
| `U7-GitHub-Publish` | Task Result tab: unchanged local result, then the publish card and its states |
| `U7-GitHub-PR` | Task "Pull request" tab: status, next-step banner, rounds, checks, review comments |
| `U7-GitHub-States` | Overview attention items, Tasks chips and filter, edge states, 390 px view |

The three autonomy presets are named combinations of `GitHubPolicy`, not a new field: "Ask me every time" is every action manual (the default); "Open pull requests for me" sets `openPullRequest: 'auto'` with `draft: true`; "Keep the pull request moving" also sets `reviewComments` and `failedChecks` to `'auto'` with `maxAutoRounds: 3`. Any other combination shows as "Custom" with the fine-tune open.

New components: `GitHubConnections.tsx`, `ProjectGitHub.tsx`, `TaskPublish.tsx`, `PullRequestTab.tsx`. The pull-request tab polls `GET /tasks/:id/pull-request` with `usePoll`, like the other task resources.

## Milestones

Each step ends with the listed check. Default tests stay deterministic: a fixture server (`scripts/github-fixture.mjs`) plays GitHub's REST and GraphQL responses, and a local bare repository is the remote. No test touches the real GitHub without authorization for that task.

| Step | Scope | Done when |
| --- | --- | --- |
| **G0 Spike** | Verify against current GitHub documentation and a sandbox repository: which fine-grained token permissions the needed endpoints require (Actions runs, jobs and logs; commit statuses; third-party check runs; GraphQL review threads); environment-based Git authentication inside the container; worktrees and diffs on a bare clone. | Findings and the changed push rule are recorded in `docs/DECISIONS.md`. |
| **G1 Connections** | Vault names, connection routes, CLI, redaction, Settings card. | Integration test: save, verify, replace, remove; the token never appears in any response, event or log. |
| **G2 Projects** | Migration v7, project source and link, managed clone, base resolver, policy storage, Projects UI. | Local-only suite passes unchanged; a managed project runs a task from the fixture remote's default branch. |
| **G3 Publish** | Operation outbox, push, open pull request, description, evidence, publish card, tab skeleton. | Completed task publishes to the fixture; killing the service between push and open resumes without a second push or pull request. |
| **G4 Sync** | Poller, snapshot, checks and comments in the tab, attention items, Tasks chips. | Fixture scenarios render: checks running, failed, none; changes requested; merged; closed; token expired; unreachable. |
| **G5 Rounds, manual** | `followUp` tasks, request composition, round worktree from the pull request head, push, thread replies. | A round addressing one thread and one failed check pushes one fast-forward commit; a branch moved by someone else is built upon, not overwritten. |
| **G6 Automatic policy** | Policy evaluation, limit, "update from main" round, workflow-file guard. | With `failedChecks: 'auto'` the fixture reaches green in two rounds; with a permanently failing check it stops after `maxAutoRounds` and raises attention. |
| **G7 Hardening and docs** | Rate limits and backoff, restart reconciliation for every operation kind, browser tests, `README.md`, `docs/SETUP.md`, `docs/REFERENCE.md`, `docs/MILESTONES.md`, `AGENTS.md`. An authorized live smoke test against a sandbox repository. | `npm run check` and `npm run test:ui` pass; the live smoke result is recorded with its date. |

G1 to G4 deliver "push and open a pull request, then watch it" without any automatic behaviour. G5 adds the feedback loop by hand. G6 is the only step that lets DevAgents act on GitHub without a click.

## Open points

1. **Checks beyond GitHub Actions.** Whether a fine-grained token can read check runs created by other apps is to be confirmed in G0. The fallback is Actions runs plus commit statuses, with other checks listed as "not readable with this token".
2. **Native credential storage.** Environment variable first, or the vault natively (G1).
3. **GitHub Enterprise Server.** The configurable API base URL makes it possible; it is not tested or supported in this plan.
4. **Squash or merge of rounds.** Rounds add commits; history is not rewritten. Teams that want one commit can squash-merge on GitHub.
6. **Deriving the connection id.** The simplified Settings board names a connection after its account instead of asking for a name: the single owner of the token's reachable repositories, otherwise the token's login, with a numeric suffix on collision. Whether an organization-owned fine-grained token always exposes that owner is to be confirmed in G0; the fallback is a name prompt only when it cannot be derived.
5. **Deleting the remote branch after merge.** Left to GitHub's repository setting; DevAgents does not delete remote branches.
