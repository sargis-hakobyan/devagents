# Codex review — U2 saved teams

Reviewed on 2026-10-30. Baseline: `ddb4073`; reviewed HEAD: `3e8a475` on local `main`, including `4aa281c` and `5880ac8`.

**Verdict: fix the five P2 findings below before calling the U2 editor accepted.** The transaction and frozen-provider design look sound in the reviewed paths. I found no new authentication bypass, mutation of a task snapshot through team editing, or migration that rewrites existing task history. The remaining problems are reproducible configuration/editor defects, not evidence that sandbox enforcement is bypassed.

Review only: implementation is unchanged. No authenticated fixture, credential inspection, push, U3 or M4 work was performed. This report is not committed.

## Findings

### F1 — P2: Permission textareas remove newlines while the user is typing

**Locations:** `ui/src/pages/Teams.tsx:184`, `ui/src/pages/Teams.tsx:220–221`.

Both scope fields parse, trim and remove empty lines on every input event, then immediately render the resulting array with `join('\n')`. When the user presses Enter after the first grant, the new empty line is removed before the second grant can be typed. Ordinary keyboard entry therefore concatenates two paths into one invalid grant. The existing workflow uses `fill()` for a single path and misses this.

**Confirmed browser reproduction:** open a developer's Advanced settings, fill Write scope with `project:/a/**`, press End then Enter, and type `project:/b/**`. The actual textarea value is `project:/a/**project:/b/**`, rather than two lines. Read scope uses the same conversion.

**Impact:** users cannot enter multiple read/write grants normally, an advertised part of member editing. Pasting an already complete multiline value is only a workaround.

**Fix:** retain raw textarea text while editing and normalize at a defined boundary, such as blur/save, or retain empty line entries in the editable state. Keep server-side grant validation. Add a browser test that types a second line with actual key events and saves/reloads both grants.

### F2 — P2: An old readiness response can overwrite the verdict for a newer draft

**Location:** `ui/src/pages/Teams.tsx:85–91`; save gating at line 116.

The effect cancels only the debounce timer. Once a request has started, its success/error handler can still call `setCheck()` after a later draft's request has completed. There is no draft generation, request identity or cancellation guard. A late validation error can disable Save indefinitely for a valid current draft; a late success can also display readiness belonging to an older draft. Server-side save validation remains intact, so this is a UI state error rather than a validation bypass.

**Confirmed browser reproduction:** clear the team name and hold the real `/teams/check` 400 response; enter `Valid current name` and allow its successful check to finish. Save is enabled. Release the old 400 response: the current name remains valid, but the editor shows `name: Too small: expected string to have >=1 characters` and disables Save. There is no further check until another edit.

**Fix:** associate each result with the current team/draft generation, ignoring stale results on edits, discard, save and navigation. An AbortController can help, but results still need a validity guard. Test responses arriving in both orders and a pending check finishing after Discard.

### F3 — P2: The archived detail page disables Restore and member inspection

**Locations:** `ui/src/pages/Teams.tsx:112–119`, `ui/src/pages/Teams.tsx:145`, `ui/src/pages/Teams.tsx:159`.

The entire editor is inside a fieldset disabled when the team is archived. Restore, Duplicate and the member-selection buttons are descendants of that fieldset. Their own `disabled={saving}` or `pointerEvents: 'auto'` cannot override native fieldset disabling.

**Confirmed browser reproduction:** open an archived team's detail page. Playwright reports `Restore.isDisabled() === true` and the Code Reviewer selection button disabled. As a result, the detail page cannot perform its offered Restore action or select another member to inspect that member's instructions. Restoring from the Teams list works, which explains why the existing archive/restore workflow passes.

**Fix:** disable only editable member/team controls, leaving navigation and authorized archive actions outside the disabled fieldset. Add tests restoring directly from detail and selecting a second archived member while all editing controls remain disabled.

### F4 — P2: Copying a registry template silently discards instructions after 16,000 characters

**Location:** `src/orchestration/service.ts:62–64`; related limits in `src/agents/registry.ts` and `src/domain/schemas.ts`.

The registry accepts instruction files up to 64,000 characters, but `templates()` silently applies `a.instructions.slice(0, 16000)`. The returned member still claims to be a copy of that template, without truncation metadata or a warning. Saving the copied member permanently loses the remaining instructions. This changes custom/user/project agent behaviour simply by moving it into a saved team.

**Confirmed service reproduction:** a temporary valid YAML/Markdown agent with 16,020 instruction characters and `REQUIRED TAIL RULE` after character 16,000 is loaded intact by `service.agents()`. `service.templates()` returns 16,000 characters and the tail rule is absent. No user agent files were inspected or changed for this probe.

**Fix:** either preserve the full supported instruction text within an explicitly enforced total payload budget, or mark the template as too large and require an explicit reviewed shortening/import step. Do not silently truncate. Add a template-copy test with a meaningful rule beyond the team-member limit.

### F5 — P2: Readiness uses a stricter reviewer rule than plan validation and execution

**Location:** `src/domain/readiness.ts:47–49`; compare `src/domain/roles.ts:15–18` and the runner's read-only review phase.

Readiness requires some reviewer to have no configured write paths at all. The shared execution policy instead requires the reviewer to be a different eligible agent from the implementer/integrator; review execution removes write grants for the review call. A distinct reviewer that also has write permissions for other duties is therefore valid for a plan but causes the team to be rejected at submission.

**Confirmed service reproduction:** copy Tech Lead, Developer and Code Reviewer templates, then give Code Reviewer `project:/tests/**` write scope. A single-item plan assigned to Developer passes `validatePlan()` with that roster, while `createTeam()` reports `ready: false` with `no_independent_reviewer`. The members have distinct IDs and the reviewer is not assigned implementation.

**Impact:** users cannot run an otherwise supported team configuration, and the handoff requirement to reuse role-selection rules is not met. The error message incorrectly equates having a write grant with being the selected implementer.

**Fix:** use the shared eligibility/independence rules to establish that a distinct implementer/reviewer combination exists, leaving the exact selected-role exclusions to plan validation. If the product instead intends a new mandatory dedicated read-only reviewer policy, it must be explicitly documented and consistently enforced by plan validation too. Add a test for a distinct writable reviewer and retain tests rejecting a reviewer that is actually the implementer.

## Requested areas reviewed

| Area | Assessment |
| --- | --- |
| Atomic team freeze | `Store.createTask()` begins an immediate transaction, checks the idempotency record, invokes the synchronous freeze callback, and inserts task/request/event before commit. `freezeTeam()` reads the project default and team revision through the same store/connection. No await or separate post-insert checkpoint breaks this boundary. |
| Team idempotency | Team edits, archival and project-default-team changes are not part of the request fingerprint and are resolved only for a new task. Explicit `teamId` remains part of the caller's request. The existing retry path returns the original task before inspecting the changed team. There is a pre-existing mode-default exception noted below. |
| Frozen engine/provider execution | `engineOf()` uses the snapshotted engine for team tasks. `provider()` looks up the snapshotted provider configuration for both preflight and execution; the DAG closure passes the team-bearing task. Legacy tasks still resolve live defaults. Non-secret provider entries contain environment-variable names, not their values. |
| Model pinning | An explicit member model overrides `defaultModel`; otherwise a configured `defaultModel` is copied. With neither, `default` remains and `modelPinned` is false. The task UI discloses the unpinned runtime choice. I found no guessed model or discovery call. This is an accurately labelled limitation, not full model immutability for unpinned tasks. |
| Validity/readiness | Strict schemas and grant-shape checks reject malformed paths, traversal, unsupported globs, push permission, duplicate IDs and nested delegation. Runtime readiness admits Codex and the official OpenAI provider path only. Unsupported capabilities/engines/providers may be stored as drafts and cannot run. Reviewer independence has F5. |
| Revisions and stale saves | Team edit/archive and project-default mutations check the expected revision/version inside transactions and return 409 conflicts. The normal stale-save browser flow retains the draft and asks the user to reload or explicitly save over the newer revision. F2 concerns asynchronous draft validation, not the store's conflict enforcement. |
| Browser security and text | New mutations run after the shared authentication/Host/Origin/CSRF checks. API tests cover missing CSRF, hostile Origin and cross-site requests. The new UI renders text through Preact, without raw HTML injection; the hostile-text workflow passes. |
| Schema-2 upgrade | The schema-3 transaction adds team tables/triggers and advances `user_version`; it does not rewrite projects/tasks/events/evidence/requests. Existing project JSON reads with version 0. Tests verify the upgrade and revision UPDATE/DELETE rejection. |
| Historical revisions | Edits/archive/restore append revision rows. UPDATE and DELETE triggers protect their stored content. Archive does not delete snapshots or task references. |

## Acceptance qualifications and existing issues

These are distinguished from the five new implementation defects above.

- **Unpinned models:** the handoff asks for fully resolved model snapshots, while the concrete U2 choice permits runtime-default execution with a warning. The flag and UI are honest, and the review request explicitly identifies this choice. Sign off full model-freeze acceptance only for tasks whose enabled members have concrete model IDs; do not describe all U2 snapshots as containing a concrete model. No live access verification is implied by either choice.
- **Unsupported capability drafts:** the handoff's test checklist says to reject unsupported capabilities, while U2 deliberately saves them as non-executable drafts, matching the illustrative Graphic Designer design. The runtime fails closed. Align the written acceptance language with that deliberate draft behaviour instead of claiming both contracts simultaneously.
- **Mode-default idempotency is a pre-existing exception:** `TaskService.submit()` at lines 86–89 resolves `defaultMode` before the store fingerprints the request. A byte-for-byte retry with omitted mode returns `idempotency_conflict` after `config.defaultMode` changes. A temporary service probe confirmed this. The same ordering exists in `ddb4073`, so it is not listed as a new U2 regression, but the statement that retries never re-resolve any defaults is too broad. A follow-up should fingerprint caller intent before resolving defaults while preserving compatibility with existing request records.
- **Coverage gap:** the U2 runner tests cover successful single-item snapshots and rejection of a DAG assignment outside the team. They do not positively execute a team-backed DAG through integration and combined review while changing provider definitions/model defaults, nor finish an already-running team task after those changes (the active gated task is cancelled). The legacy DAG tests are useful but do not replace those snapshot-specific cases. Add these for the full handoff acceptance contract.
- **Readiness policy detail:** disabled members with unavailable engines/providers/capabilities still produce blocking diagnostics. The current implementation requires their removal or correction, not merely disabling them. This is worth deciding/documenting explicitly; I have not counted it as a confirmed regression because the draft policy currently says every error must be resolved.

## Verification performed

- `npm run check`: **passed, 120 tests, 0 failures, 0 skips**, backend/UI typechecks and production build.
- `npm run build`: passed independently before the targeted browser probes.
- `npm run test:ui`: **passed, all 18 workflows**. Launched with `DEVAGENTS_CREDENTIAL_RUNTIME` pointing to a new empty temporary directory so the fixture's status reporting used an isolated file store rather than the host keychain.
- Temporary headless Chromium probes against the real built UI and an in-memory store confirmed F1, F2 and F3. The service used a static synthetic status response and synthetic browser authentication, with no engine-health or credential calls. An initial probe used the wrong template label (`General Developer` rather than `Developer`) and timed out; correcting that locator produced the recorded results without changing application code.
- Temporary service probes confirmed F4, F5 and the existing mode-default retry limitation. The long instruction template was created only in a new temporary directory and removed afterwards.
- Did not repeat the standalone M2/M3, protocol or Docker suites; the full suite and targeted U2/browser probes were sufficient for these findings. The author's reported Docker pass is not presented as an independently rerun result here.
- No authenticated live fixtures, real credentials, user projects, external services, merges or pushes were used. No implementation or repository test files were modified.

The checkout started clean at `3e8a475`. Local tracking metadata reported `main` ahead 5 / behind 1 relative to `origin/main`; no fetch, pull or reconciliation was performed during review. Only this requested report was added to the repository.
