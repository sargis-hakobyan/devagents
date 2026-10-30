# Claude review — U3 browser workflows and guided setup

Reviewed on 2026-10-30. Baseline `c86d342` (design handoff); reviewed HEAD `0f1f90d` on local `main`, eight commits `54cc99b`…`0f1f90d`. Review only: no implementation, test or document was modified; nothing was pushed; no authenticated fixture ran and no credential store was inspected. The report is committed together with the F1 fix.

**Verdict: accept U3 with one P2 fix before calling the diff endpoint's redaction contract met (F1). The remaining findings are P3 polish.** Registration, submission, retry identity, decisions, diff ownership checks and guided setup follow the handoff and the approved boards; the security contract (cookie session, Host/Origin/CSRF, text-only rendering) is intact on every new route.

## Findings

### F1 — P2: Diff redaction misses configured provider secrets that the store already treats as secret

**Location:** `src/orchestration/service.ts:88` (`diff()` calls `readTaskDiff(project, task, this.dataDir)` with the default secret list); `src/workspace/diff.ts:15` (`secrets = environmentSecrets()`); compare `src/cli/main.ts:48–49`, where the service builds `[...environmentSecrets(), ...configuredSecrets]` for the store.

`environmentSecrets()` selects environment variables by name (`key|token|secret|password|authorization|cookie|credential`). A provider configured with `auth: api-key` and an `apiKeyEnv` outside that pattern (the schema allows any `[A-Z][A-Z0-9_]*` name) is added to the store's secret list at startup, so task rows and evidence are redacted at rest. The diff reader and the response redaction in `send()` only use `environmentSecrets()`, so the same value committed into a task branch is returned verbatim by `GET /tasks/:id/diff`.

**Confirmed by a temporary service probe:** provider `custom` with `apiKeyEnv: MYPROV_AUTH`, the value present in the environment and passed to the store; a completed task whose final commit contains the value. `store.task()` is redacted; `service.diff()` returns the value in `files[0].text`. The probe used a throwaway fixture repository and a synthetic value only.

**Fix:** give `TaskService.diff()` the store's secret list (expose it read-only or pass `configuredSecrets` into the service) and use it in `readTaskDiff`; keep the environment heuristic as well. Add a regression test with an `apiKeyEnv` name that does not match the heuristic. Optionally apply the same list in `send()` for consistency with at-rest redaction.

### F2 — P3: The Overview "Finish setup" note is unconditional

**Location:** `ui/src/pages/Overview.tsx:18`.

The note shows on every Overview render, including a fully set-up workspace. The board (`U3-Setup`, "How this shows up elsewhere") shows it only while steps are unfinished, from status data. Suggest gating on `status.codex.installed && signedIn && !vaultLocked` plus at least one project, or converting it to a quiet link.

### F3 — P3: Unexpected errors in the diff reader are reported as `diff_unavailable`

**Location:** `src/workspace/diff.ts:53–55`.

Every non-`AppError` thrown inside the try block, including filesystem or spawn failures unrelated to the task's metadata, becomes a 409 "unavailable" with the generic ownership message. The fail-closed behaviour is right; consider logging the underlying error through `log()` (redacted) so an operator can tell a broken installation from a missing commit.

### F4 — P3: Diff reads up to 1 MiB per file for every text file before the total budget is exhausted

**Location:** `src/workspace/diff.ts:36–45`.

Redacting before truncation justifies reading past the 64 KiB display cap, but a 200-file change can cost up to 200 × 1 MiB of Git output per request, and the Result tab issues the request on every open of a completed task. Local single-user service, so not a security concern; note it as a known cost, or stop reading once `remaining` is small and mark the rest truncated (already done once `remaining <= 0`).

### F5 — P3: Browser fixture status passes the whole config object as `limits`

**Location:** `scripts/ui-fixture.mjs:84`.

`limits: config` serves the entire parsed configuration (providers, defaults, timeouts) under the `limits` key. Nothing secret is in it and only the fixture uses it, but the status shape should be built explicitly so the fixture cannot drift from `ServiceStatus`.

### F6 — P3: Browser coverage of binary, truncated, empty and unavailable diff states uses faked responses

**Location:** `tests/ui/u3.spec.ts:286–303`.

The backend produces those states under `tests/integration/diff.test.ts`, and the browser renders them from `page.route` fulfilments, so no browser test exercises the real endpoint for anything but the complete single-file case. Acceptable for this increment; a fixture task with a binary and an oversized file would close the gap cheaply.

## Requested areas reviewed

| Area | Assessment |
| --- | --- |
| Registration | `POST /projects` with strict `ProjectInput`; `inspectProject` now maps a missing path to an actionable message mentioning the container path; the form keeps input on refusal and shows the service's message verbatim (browser test). Docker guidance with copyable commands matches the board. No cloning, mounting, folder picker or filesystem browser. |
| Submission | `/ui/tasks/new` is registered before `/ui/tasks/:id`. Project, request, criteria, team and mode as designed; drafts and archived teams are listed disabled with the first error diagnostic; the "Project default" option is disabled when the default is unavailable, and no legacy override exists. Effective mode and its source come from `GET /submission-options` (authenticated, secret-free). The accepted panel shows the frozen team and revision from the response, not the preview. |
| Retry identity | One UUID key and the exact payload are written to `sessionStorage` before the request; the form is read-only while an attempt is pending or unresolved; a dropped response, double click, reload, session renewal and a real service restart reuse the same key and produce one task (browser tests); a changed payload with the old key conflicts. Abandon is explicit with the "first task may exist" warning; storage failure refuses to send. Only task input is stored; no cookies, tokens or provider values. Refusals that cannot succeed on retry (4xx other than 401/403/408/409, `team_archived`, `team_not_ready`, `not_found`) clear the attempt. |
| Mode, approval, cancellation | Two equal mode buttons, none preselected. Header and Plan tab share one guard (`useTaskActions`); approval sends the displayed `version`; a 409 reloads, disables Approve and requires "Review updated plan" before a new click (browser test with a second writer bumping the version). Reject is cancellation with a confirmation naming the consequence. Committing shows no cancel control and a real `409 commit_in_progress` is rendered. Resubmission from a finished task copies request and criteria only, with a new key. |
| Diff | Addressed by task id only; any query string is refused with 400. The reader verifies the recorded worktree path under the data directory's canonical `worktrees` folder, the branch name pattern, the registered repository's canonical path and top level, both commit objects, that the branch still points at the final commit and that base is an ancestor. `--no-ext-diff --no-textconv`, literal pathspecs, hooks and system config disabled; the test proves repository-configured external diff and textconv never run. Binary, protected (`withheld`), truncated, empty and unavailable are distinct; an empty result requires both commits. Over-read files omit text entirely so a cut secret cannot escape. F1 is the one gap. |
| Guided setup | Reads existing status only; steps for browser session, runtime, saved sign-in (with locked-vault variant), model access (test disabled), project and team; copyable terminal commands; no input fields (asserted), no POST during the flow (asserted), no automatic connection test. Submit stays reachable with a warning, as the owner's default. |
| Security | New routes sit behind the shared authentication: `/submission-options` and `/tasks/:id/diff` return 401 without a session, 403 on a foreign Origin or Host; `/projects`, `/tasks`, mode, approve and cancel return 403 without CSRF or with a foreign Origin (API test). Diff text, paths and request text render through Preact as text; hostile paths and script tags appear as text with no element created (browser test). |
| Docs | README, milestones, decisions and the plan describe the delivered scope, the diff limits and the deferred cleanup/patch download accurately. The milestone's "32 workflows, 131 tests" matches the suites. |

## Verification performed

- `npm run check`: passed, 131 tests, 0 failures, backend and UI typechecks, production build.
- `npm run test:ui`: passed, 32 workflows (13 U1, 9 U2, 10 U3) against the labelled fixture; representative screenshots inspected (`u3-register-error`, `u3-submit`, `u3-submit-narrow`, `u3-accepted`, `u3-approval`, `u3-diff`, `u3-setup-narrow`). They match the boards in structure and copy; the implementation omits some secondary panels from the boards (team-unavailability card, "what happens next", registration state gallery), which is acceptable.
- Two temporary service probes with a throwaway repository: (1) the configured-secret case above (F1 confirmed); (2) a symlinked data-directory path for `readTaskDiff`, which works because worktree paths are recorded canonically at creation. No user project, credential store, external service, push or merge was involved; the probe files live outside the repository.
- Not repeated: Docker smoke, protocol smoke and the M2/M3 standalone fixtures. The author's reported passes are not presented here as independently rerun.

## Acceptance qualifications

- Cleanup and patch download remain unavailable from the browser, as the handoff requires; the Result tab says so.
- Live or failed-task diffs are explicitly not offered.
- The `/submission-options` projection exposes only the effective mode and its source per project.
- The sign-in warning on the submit form is the owner's chosen default (form usable, planning fails at preflight); a failed task links to setup.
- The checkout started clean at `0f1f90d` and remains clean apart from this report.

## Fix applied — 2026-10-30

F1 is fixed in the commit that adds this report: `Store.secrets` is readable, `TaskService.diff()` passes it to `readTaskDiff`, and API responses are redacted with the union of the environment heuristic and the store's list. Regression test `tests/integration/diff.test.ts` ("review F1") commits a configured provider value under `MYPROV_AUTH` and asserts it is absent from `service.diff()`, the HTTP diff response and the stored task; it failed against the previous source and passes now. `npm run check`: 132 tests passed; `npm run test:ui`: 32 workflows passed. F2–F6 remain open as P3 notes.
