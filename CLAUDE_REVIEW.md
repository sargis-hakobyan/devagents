# DevAgents M0–M3 review (pre-M4)

Reviewed commit: `d9dd377` (branch `codex/devagents-foundation`, clean working tree), with attention to the M3 commits `044e6e3` and `d9dd377`.
Inputs: `DEV_AGENTS_SPEC.md`, `IMPLEMENTATION_PROMPT.md`, `README.md`, `docs/MILESTONES.md`, `docs/DECISIONS.md`, `docs/M0_FINDINGS.md`, all of `src/`, `tests/`, `scripts/`, `agents/builtin/`, `compose.yaml`, `Dockerfile`, the `devagents` launcher.
Review only: no implementation, test or doc files were modified; nothing was committed. No authenticated model run was performed and no credential store was inspected.

## Checks run

| Check | Result |
| --- | --- |
| `npm run check` (typecheck, `npm test`, build) | Pass: 64 tests, 0 failures, 0 skipped |
| `tests/integration/dag-runner.test.ts` run 3× | 11/11 pass each run; no flakiness observed |
| `npm run test:m2` (deterministic engine, real Codex 0.160.1 sandbox for validation, native macOS) | Pass, including the containment probe (validation cannot read service credentials, write the original checkout or Git metadata, or inherit service secrets) |
| `npm run test:m3` (deterministic engine, real Codex 0.160.1 sandbox for validation, native macOS) | Pass: three items, isolated worktrees, dependency integration, item and combined reviews, one final commit, original checkout unchanged |
| `npm run test:codex-protocol`, `npm run test:docker` | Not run. The protocol fixture launches the pinned Codex binary with the keyring credential store selected and `HOME` set to the real home directory, so it can touch the OS keychain; the Docker suite rebuilds images. Both are non-live but out of scope for this pass. |
| Live fixtures (`test:codex-live`, `test:m3-live`) | Not run, per instructions |

Targeted empirical checks (scratch scripts, not added to the repo):

- Redaction applied to a code diff rewrites identifiers (confirms F1).
- A git-ignored file written in a worktree is absent from `git ls-files --others --exclude-standard` and `git diff HEAD` (confirms F2).
- Calling `TaskRunner.stop()` while a fixture worker runs leaves the task in state `cancelled`, actor `orchestrator` (confirms F3).
- After a completed single-item run, the user's repository still lists the task branch and the managed worktree (confirms F7).
- The conflict-marker regex matches a Markdown setext heading underline (confirms F5).
- This repository's own dev `node_modules` holds 12,343 entries and 7 symlinks (context for F4).

## Verdict

M3 is functionally complete against the documented milestone checklist and the deterministic tests back every M3 claim that can be verified without credentials. The code is small, carefully fail-closed, and the M2→M3 diff introduced no regressions I could find in the single-item path. I did not find a defect that makes M3 unsafe for the user's original checkout: every path I traced keeps writes inside managed worktrees and the final commit on an owned branch.

I would not start M4 before fixing F1 and F6, and I recommend fixing F2, F3 and F5 in the same pass. F1 silently degrades the independent review for a very common class of code (anything mentioning `token`, `secret`, `password`, `apiKey`) and would have been invisible to the greeting fixtures. F6 lets a user approve a plan that cannot run. The rest are hardening items that can ride along with M4 or wait for M5.

Readiness summary:

- Blockers before M4: F1, F6.
- Strongly recommended before M4: F2, F3, F5, F4.
- Can be scheduled into M4/M5: F7 through F17, the layering notes and the test gaps.

## Findings

Severity: High / Medium / Low. Status: **Confirmed** (reproduced or unambiguous from code), **Question** (behaviour is deliberate or not, needs a decision), **Unverified** (plausible from code, not reproduced).

### F1. Secret redaction rewrites the diff that the reviewer and the repairing implementer see

Severity: High. Status: Confirmed.

Files: `src/telemetry/redact.ts:6`, `src/engines/codex/adapter.ts:61`, `src/orchestration/dag-runner.ts:83` (review prompt with `Diff:`), `src/orchestration/runner.ts` review prompt in the single-item loop, and both `feedback = ...` strings that embed review JSON.

The heuristic pattern `((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s,;]+` is applied to the whole model prompt by the adapter. Verified output for a TypeScript diff:

```
+const token: [REDACTED] = req.headers.authorization;
+  password: [REDACTED];
+  apiKey = [REDACTED];
+interface Session { token: [REDACTED]; secret?: Buffer }
+export const secret = [REDACTED];
```

Failure scenario: a task touches auth or session code. The reviewer receives a diff where types and right-hand sides are replaced, cannot assess correctness, and either approves blind or reports `[REDACTED]` as a defect. Repair feedback to the implementer is mangled the same way, so repair cycles burn `maxRepairCycles` on a phantom problem and the task fails with `repair_limit`. The live fixtures could not surface this because greeting code contains none of these words.

Recommended fix: redact model input only against concrete secret values (`environmentSecrets()` plus the provider key), not the key/value heuristic. Keep the heuristic for logs and persisted evidence if wanted, but note that persisted review findings and diffs become unreliable evidence too. Add a unit test asserting that a diff containing `token: string` reaches `EngineRequest.prompt` unchanged, and a runner test where the fake engine's implementation writes such code and the review prompt still contains it.

### F2. Validation runs against the worktree, but review and commit only see files git does not ignore

Severity: Medium. Status: Confirmed.

Files: `src/workspace/changes.ts:13` (`ls-files --others --exclude-standard`), `src/orchestration/runner.ts` single-item loop (validate then `commitChanges` in the same worktree), `src/orchestration/dag-runner.ts:63` and the combined gate.

Ignored files written by a worker are not in `files`, not in the review diff, and not committed, yet validation commands run in that same worktree and can depend on them. README explicitly expects ignored content (installed `node_modules`) to live in the worktree, so the mechanism is by design; the gap is that newly created ignored files are not detected.

Failure scenario (single-item): the project's `.gitignore` contains `*.local.js`. The implementer, or repository content acting through prompt injection, writes `helper.local.js` and makes the test import it. Validation passes, the reviewer never sees the helper, the commit omits it, and the task completes with a branch whose tests fail on checkout. In the DAG path the integration patch also omits the file, so the combined gate usually catches cross-item cases but not files created in the task worktree during integration repair.

Recommended fix: snapshot `git ls-files --others --ignored --exclude-standard` before each implementation call and fail (or at least record and surface to the reviewer) when new ignored paths appear outside an allowlist such as `node_modules/`. Also treat `.gitignore` edits like `.gitattributes` edits, or at minimum flag them in the review prompt. Test: fake engine writes an ignored file that the test requires; assert the task does not complete, or the reviewer prompt names the hidden file.

### F3. Graceful shutdown records in-flight tasks as `cancelled`, contradicting the documented recovery contract

Severity: Medium. Status: Confirmed.

Files: `src/orchestration/runner.ts:32` (`stop()` aborts the active task), `src/orchestration/runner.ts:168` (`signal.aborted ? 'cancelled' : 'failed'`), `src/cli/main.ts:58-61`, `src/persistence/store.ts:137-139`.

Reproduced: a running fixture task ends in `state: cancelled`, actor `orchestrator`, with the engine's error text as the reason. README ("active execution states are marked failed for inspection") and `docs/DECISIONS.md` ("Recovery marks interrupted execution failed") describe a different outcome. Because `cancelled` is terminal and not in the recovery filter, a `docker compose restart` during a task produces a history that reads as a user cancellation and is never surfaced by `recover()`.

Recommended fix: in `run()`'s catch, distinguish `this.stopping` from user cancellation and move to `failed` with a reason such as "Service shutdown interrupted execution"; or introduce an explicit actor/reason for shutdown. Test: start a waiting fixture worker, call `stop()`, assert the terminal state and reason, and assert that `recover()` on the reopened store reports it.

### F4. The per-run sandbox scan does not scale to projects with installed dependencies

Severity: Medium. Status: Confirmed from code; not reproduced on a 50k-file tree.

Files: `src/engines/codex/sandbox.ts:40-45` (recursive scan, 50,000-entry cap, one deny entry per symlink or hardlink), called from `src/engines/codex/adapter.ts` on every `execute` and from `src/engines/codex/validator.ts:24` on every validation command.

README tells users to install dependencies into the managed worktree while paused at plan approval. A typical front-end or monorepo `node_modules` exceeds 50,000 entries (this repo's small dev tree is already 12,343). Once over the cap every engine call and every validation command throws `workspace_limit`, so an approved task fails immediately after approval. Below the cap, every `node_modules/.bin` symlink adds a `-c` flag to the Codex command line, and the full tree is walked for each of the many process launches in a DAG run.

Recommended fix: do not descend into directories that are fully ignored or that will be denied anyway; grant `node_modules` as a single read-only subtree instead of enumerating; cache the scan per worktree between calls within one run; make the limit configurable and the error actionable. Test: a fixture tree above the limit (or an injected lower limit) that still executes, plus an assertion on the generated flag count for a tree with many `.bin` symlinks.

### F5. Conflict-marker detection has false positives that make some conflicts unresolvable

Severity: Medium. Status: Confirmed.

File: `src/orchestration/dag-runner.ts:166` (`/^(<{7} |={7}$|>{7} )/m`).

`=======` alone on a line is a legal Markdown setext heading underline and appears in other text formats. Reproduced: the regex matches `Title\n=======\nbody`. If a `.md` file in an owned path conflicts, the integration repair can never be marked resolved, the shared integration repair budget is exhausted, and the task fails with a misleading `integration_conflict`.

Recommended fix: after the integrator edits, determine resolution from Git state (`git diff --name-only --diff-filter=U` after `git add`), and only treat `=======` as a marker when it sits between `<<<<<<< ` and `>>>>>>> ` lines. Test: conflict fixture on a Markdown file with a setext heading.

### F6. A plan can be presented for approval that is guaranteed to fail at execution

Severity: Medium. Status: Confirmed from code.

Files: `src/domain/plan.ts:17-31` (`validatePlan`), `src/orchestration/service.ts` `proposePlan`, versus execution-time checks in `src/orchestration/dag-runner.ts:40-48` (validation command shape, reviewer independent of every implementer and the integrator), `src/orchestration/runner.ts:115-117`, and `src/engines/codex/sandbox.ts:33` (Linux subtree-only write grants).

`validatePlan` checks the DAG, capabilities and ownership but not: that every validation command passes `assertValidationCommand`; that a reviewer exists who is not an implementer or the integrator; or, on Linux, that owned write paths are subtree grants. In plan-approval mode the user therefore reviews and approves a plan that then fails on the first execution step with `command_denied`, `missing_agent` or `unsupported_policy`. The regression test "unsupported combined validation is rejected before any worker starts" passes only because it runs in autonomous mode; with the builtin roles the reviewer case cannot occur, but a custom role with both `review` and write permissions makes it reachable.

Recommended fix: move `assertValidationCommand`, reviewer-independence and the platform write-grant check into `validatePlan` (or a `proposePlan` precheck that receives platform capabilities from the engine). Test: plan-approval mode with a `node -e` validation command asserts `planning → failed` without ever reaching `awaiting_plan_approval`; a custom role that is both implementer and the only reviewer is rejected at proposal time.

### F7. Managed worktrees and branches are never reclaimed, and the user's repository accumulates them

Severity: Medium (operational). Status: Confirmed.

Files: `src/workspace/git.ts:49` (`git worktree add -b` in the user's repository), `src/orchestration/dag-runner.ts:92,134`, `src/persistence/store.ts:137`. No `worktree remove`, `worktree prune` or branch deletion exists anywhere in `src/`.

After a completed single-item run the user's repository lists `codex/devagents-<task>` as a branch and a registered worktree; a three-item DAG adds three item branches whose bases are "dependency checkpoint" commits. Spec §3 gives `WorkspaceManager` the job to "create/clean owned worktrees" and §5 requires restart reconciliation of orphaned worktrees. Failure scenario: a few dozen tasks leave dozens of full checkouts under the data directory (and the Docker volume) and dozens of branches in `git branch`, with no supported way to clean them other than manual `git worktree remove`.

Recommended fix: an explicit, user-invoked retention command (`tasks cleanup <id>` or an age-based sweep) that removes only worktrees and branches DevAgents created and recorded in evidence; never touch anything else. Record worktree creation in a registry table so `recover()` can report orphans. Test: cleanup removes managed worktrees and branches, refuses unmanaged ones, and leaves the user's branches and dirty work untouched.

### F8. The planner runs with the shell tool enabled before any approval

Severity: Low. Status: Question.

Files: `agents/builtin/tech-lead.yaml:17` (`allowCommands: true`), `src/engines/codex/adapter.ts:48` (`features.shell_tool=${permissions.allowCommands}`), `src/orchestration/runner.ts:97`.

In the planning phase Codex receives `exec_command` with a read-only project, writable temp and no network. Repository content (prompt injection) can therefore cause code execution inside the sandbox before the user has seen or approved anything. The blast radius is bounded by the sandbox, and the M0 probes cover containment, but the spec frames planning as "probe project context". Decide whether planning should be read-only (`allowCommands: false` for `tech-lead` by default) or document the choice.

### F9. `approved: false` with empty `findings` yields an empty repair instruction

Severity: Low. Status: Confirmed from code.

Files: `src/orchestration/outputs.ts` (`ReviewOutput`), `src/orchestration/dag-runner.ts` and `src/orchestration/runner.ts` feedback construction.

The schema allows a rejection with no findings. The implementer then receives "Repair independent review findings" with an empty array and nothing to act on, consuming a repair cycle. Recommended fix: `superRefine` requiring at least one finding when `approved` is false, treating a violation as malformed engine output rather than a repair request. Test: fake engine returns that shape; assert the run fails with `malformed_output`-style error, not `repair_limit`.

### F10. Oversized validator or Git output fails the task instead of becoming evidence

Severity: Low. Status: Confirmed from code.

Files: `src/engines/codex/validator.ts:29` (`maxBytes: 1 MiB`), `src/engines/process.ts:30,38` (throws `output_limit`), `src/workspace/git.ts:12` (`maxBuffer: 2 MiB`), `src/orchestration/runner.ts:91` (planning file list).

A noisy test suite producing over 1 MiB terminates the validation process and the error propagates as a thrown exception, so the item fails hard rather than recording a failed validation that the repair loop could address. Likewise a diff or `ls-files` listing over 2 MiB surfaces a raw Node `maxBuffer` error. Recommended fix: truncate validator output (head and tail) and record it as a failed validation with a truncation marker; bound the planning file list by count; map `maxBuffer` to an `AppError`. Test: validation command that prints 2 MiB.

### F11. Two deny lists drift

Severity: Low. Status: Question.

Files: `src/domain/policy.ts:10` (`.env*`, `.ssh`, `.aws`, `.codex`, `.claude`, `*.pem`, `*.key`) versus `src/engines/codex/sandbox.ts:9` (`deniedSegments` adds `.devagents`, `.agents`, `.npmrc`, `.netrc`, `.mcp.json`).

Today every path that reaches `PolicyEngine.file` has already passed `protectedPath` (in `changes()` and the planner's file listing), so I found no exposure. It is a maintainability risk: the next caller of `PolicyEngine.file` will inherit the narrower list. Recommended fix: one exported deny predicate used by both.

### F12. Concurrent `seal()` calls can persist a stale refreshed token

Severity: Low. Status: Unverified.

File: `src/engines/codex/adapter.ts:81` (`seal()` in every `execute` `finally`), `src/security/credential-vault.ts` `save`/`atomic`.

Two workers finishing close together each read `auth.json` and rename a fresh ciphertext into place; last rename wins. If Codex rotated the ChatGPT refresh token between the two reads, the older token can be the one persisted and the next unlock may require re-login. Likelihood is low and the failure is recoverable. Recommended fix: serialize `seal()` with an in-process mutex and skip the write when plaintext is unchanged.

### F13. Parallel `git worktree add` on one repository is not serialized

Severity: Low. Status: Unverified (three test runs showed no failure).

Files: `src/orchestration/dag-runner.ts:92`, `src/workspace/git.ts:49`.

Items in a wave create their worktrees concurrently in the same repository. Git protects refs with lock files, so a collision would surface as a `.lock` error, fail the item and drain siblings, which is safe but noisy. Recommended fix: a tiny mutex around `createItem`; creation is cheap compared to engine calls.

### F14. Siblings aborted by another item's failure are recorded as `cancelled`

Severity: Low. Status: Confirmed from code.

File: `src/orchestration/dag-runner.ts:125` (`workerSignal.aborted ? 'cancelled' : 'failed'`).

When item `a` fails, item `b` is aborted through the shared worker signal and its evidence says `cancelled` although nobody cancelled it; the task itself is `failed`. Recommended fix: record `aborted` with reason "sibling failure" when the task signal is not aborted. Test: extend "failed work item aborts siblings" to assert sibling state and reason.

### F15. `GET /tasks` returns the full agent snapshot for every task

Severity: Low. Status: Confirmed from code.

Files: `src/persistence/store.ts` `tasks()`, `src/api/server.ts`.

Each task persists `agents` including instruction text (up to 64 KB per agent). The list endpoint and `tasks list` therefore grow by hundreds of kilobytes per task. Recommended fix: project a summary (id, state, project, created, branch) for the list and keep the snapshot on `GET /tasks/:id`.

### F16. Single-item reviewer selection is looser than the DAG path

Severity: Low. Status: Confirmed from code.

Files: `src/orchestration/runner.ts:117` versus `src/orchestration/dag-runner.ts:48`.

The single-item path does not require `delegation.canReceiveTasks` for the reviewer. Harmless with the builtins; align the predicate with the DAG path.

### F17. Documentation drift

Severity: Low. Status: Confirmed.

- README "Troubleshooting and limits" says interrupted work is marked failed; see F3.
- README states the API token file is created with mode `0600`; `src/api/server.ts` also `chmod`s on every start, fine, but the data directory itself is created `0700` only when missing, so a pre-existing world-readable data directory is not tightened. Worth a line in the security section.
- `docs/MILESTONES.md` "Acceptance commands" lists 64 tests, which matches.

## DAG scheduling, concurrency and dependency handling

Traced and found correct:

- `readyWave` (`src/orchestration/dag-scheduler.ts`) is deterministic, respects `dependsOn`, the global `concurrency` cap and per-agent `concurrency`; `scheduler_stalled` is only reachable with an invalid DAG, which `validatePlan` already rejects. Unit test covers the four cases.
- `AgentSlots` serializes reviewer and integrator calls by agent id, releases waiters on completion and rejects queued waiters on abort without acquiring a slot. The wake-all strategy is correct, if a little busy.
- Each wave snapshots the integration index with `write-tree`/`commit-tree` so item worktrees start from integrated dependency results without advancing the task branch; the final commit's parent is the original HEAD, giving one squashed commit on the task branch.
- Item worktrees are per item; the integration worktree is only touched by the serial main loop; nothing writes to the user's checkout other than `git worktree add` metadata and branch refs (see F7).
- Cancellation propagates through a per-wave `AbortController`; `Promise.allSettled` drains all workers before the wave loop rethrows; unstarted items are marked `blocked` or `cancelled`.

Design limitations, documented and acceptable for M3: wave scheduling (no refill when a slot frees), one top-level task at a time, the single reviewer serializes all item reviews, and items may hold a global slot while queued for review.

## Sandbox permissions and Git/worktree isolation

Traced and found correct:

- Write grants are narrowed to `ownedPaths` and never widened (`scopeAgent`), passed into the Codex permission profile, and re-checked after the fact by `changes()` through `PolicyEngine`. The `outside` and `unsafe-planned-path` tests cover the post-hoc check; the protocol smoke covers the in-sandbox grant (not part of `npm test`, see test gaps).
- Reviewer and planner processes get `writePaths: []`; reviewer additionally gets `allowCommands: false`.
- `.git`, `.devagents`, credential directories, symlinks and hardlinks are denied; `.gitattributes` changes, binaries, files over 512 KB, filters and merge drivers are refused; hooks, fsmonitor, global/system config and attributes are disabled for every Git call; `GIT_LITERAL_PATHSPECS` prevents pathspec magic.
- The original checkout's HEAD must equal the task base at final commit; the review prompt also carries a before/after `git status` comparison of the original checkout.

Open points are F2 (ignored files), F4 (scan scalability), F8 (planner shell) and F11 (deny-list drift). Not verified here: the Linux bubblewrap behaviours described in `docs/M0_FINDINGS.md`; the `process.platform === 'linux'` branch in `sandboxFlags` is untested on macOS CI.

## Authentication and secret storage

Reviewed `src/security/credential-vault.ts`, `src/engines/codex/{setup,device-login,connection-test}.ts`, `src/cli/{secret-prompt,choice-prompt,onboarding}.ts`, the launcher and `scripts/vault-key.sh` usage. Credential contents were not inspected.

Sound: AES-256-GCM with fresh nonces, AAD and tag checks; verify-before-replace; atomic rename and directory fsync; tmpfs magic check before placing plaintext; the master key is only accepted over stdin; the API key is passed to Codex on stdin only; `shell_environment_policy.inherit="none"` keeps `CODEX_API_KEY` away from tools (asserted by the protocol fixture); hidden key entry with cancellation paths; fixed, non-echoing failure messages in the connection test; bearer token compared in constant time; browser `Origin` requests refused; bind address restricted.

Concerns: F12 (seal race). Also `preflight()` runs `codex --version` and `codex login status` on every `execute`, which is two extra process launches per model call in a DAG run; consider caching per run.

## Validation, independent review and bounded repair

Correct and well guarded: validation commands are restricted to a fixed allowlist and run in a read-only sandbox; file digests are compared before and after validation and after review; approval requires `approved && findings.length === 0` (the contradictory-approval regression is tested); per-item and shared integration repair budgets are bounded; the item gate and the combined gate carry distinct instructions after the live finding in `d9dd377`.

Concerns: F1 (the reviewer may not be reading the real diff), F9 (empty findings on rejection), F10 (output limits are fatal rather than evidence).

## Cancellation, recovery and failure handling

Correct: `committing` is a short non-cancellable boundary and `cancel` returns 409 during it (tested); cancellation terminates engine process groups with SIGTERM then SIGKILL; `recover()` marks interrupted execution states failed and never replays Git or external effects; approval waits survive restart; the service lock releases after a crash (tested).

Concerns: F3 (shutdown is recorded as cancellation), F7 (no reconciliation of worktrees on disk), F14 (sibling abort labelled cancelled). The DAG recovery test writes evidence by hand rather than interrupting a real DAG run, so the actual interrupted-state shape after a crash mid-wave is untested.

## Missing tests and regressions

No regressions found between `4092b05` and `d9dd377` in the single-item path; the refactor moved `jsonSchema` into `outputs.ts` and preserved behaviour, and `commitChanges` now delegates to `commitOwned` with an added HEAD/branch check.

Tests I would add, in priority order:

1. Redaction does not alter model prompts containing `token: string` (F1).
2. New ignored files created during implementation are detected (F2).
3. `TaskRunner.stop()` during execution yields a `failed` task with a shutdown reason, visible to `recover()` (F3).
4. `validatePlan` rejects unsupported validation commands and non-independent reviewers in plan-approval mode before `awaiting_plan_approval` (F6).
5. Conflict on a Markdown file with a setext heading resolves (F5).
6. The DAG runner test should assert that every implementation call's `agent.permissions.writePaths` equals the item's `ownedPaths` (the in-sandbox grant), not only the post-hoc `changes()` check. Today that is only covered by the protocol smoke, which `npm test` does not run.
7. A real interrupted DAG run (kill the process mid-wave) followed by `recover()`, instead of hand-written evidence.
8. `integrateItem` when the patch fails for non-conflict reasons (`integration_failed`), and conflict in more than one file per item.
9. Validator output above `maxBytes` and Git output above `maxBuffer` produce actionable errors (F10).
10. A worktree above the scan limit, or a test that `node_modules` is not enumerated (F4).
11. `ReviewOutput` with `approved:false, findings:[]` (F9).
12. The Linux-only branch of `sandboxFlags` via dependency injection of the platform, so macOS CI exercises the exact-file rejection path.

## Milestone correctness

- M0: documented findings are consistent with the code I read (pinned CLI version, feature flags, `agents.enabled=false`, TOML inline tables, enumerated deny targets). Claims about live behaviour were not re-verified.
- M1: every checklist item maps to a passing test (`lifecycle`, `api`, `registry`, `crash`, `service-lock`, `workspace`, `policy`).
- M2: every checklist item maps to `runner.test.ts` or the auth/vault unit tests; the live acceptance is documented and not re-verified here.
- M3: every checklist item maps to `dag-runner.test.ts`, `dag-scheduler.test.ts`, `dag-recovery.test.ts` or `output-schema.test.ts`, with the caveats under "Missing tests" (recovery test is synthetic; in-sandbox scoping is only covered by the protocol smoke). The README's description of M3 behaviour is accurate except for the interruption semantics (F3).

## Notes for M4 (not defects)

- `TaskRunner` is bound to exactly one `CodingEngine`; `provider()` (`src/orchestration/runner.ts:53`) rejects any other engine and the planner prompt filters agents to that engine. Per-agent engine selection needs an engine registry keyed by `engine` id passed into both runners, and per-engine `preflight`.
- Engine-agnostic policy lives under the Codex adapter and is imported by domain and workspace code: `protectedPath` and `deniedSegments` from `src/engines/codex/sandbox.ts` into `src/workspace/changes.ts` and `src/orchestration/runner.ts`; `assertValidationCommand` from `src/engines/codex/validator.ts` into both runners. Lift these into `domain/` or `workspace/` before adding a second engine.
- `EngineRequest.schema` is a JSON Schema tailored for Codex `--output-schema` (including the `ScopedPath` regex workaround in `outputs.ts:12`). The Claude adapter will need its own structured-output strategy and the same local Zod validation.
- Platform branching (`process.platform === 'linux'` in `sandboxFlags` and in the planner prompt) is Codex-specific; model it as engine capabilities (`supportsExactFileWrites`, `supportsCommandTool`) so the planner prompt and `validatePlan` (F6) can consult them.
- `EngineProgress` kinds (`command`, `file-change`) and `CodingEngine` (no `capabilities()`/`cancel(runId)`, cancellation via `AbortSignal`) differ from the spec sketch; the AbortSignal design is fine, but write the normalized event contract down before the second adapter so both emit the same shapes.
- `engineHealth` already probes `claude --version`; the registry already accepts `engine: claude-code`. A config with `defaultEngine: claude-code` today fails at the first `provider()` call with `engine_unavailable` after creating a worktree, which is acceptable but should become a preflight error before worktree creation.

## Smoke fixtures

`npm run test:m2` and `npm run test:m3` both passed natively on macOS ARM64 with Codex CLI 0.160.1 installed and no credentials. Each creates and removes its own temporary repository and data directory; neither touched registered projects or the credential store.
