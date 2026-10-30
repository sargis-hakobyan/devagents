# U1 status review fixes — 2026-10-30

Reviewed baseline: `c9836a0`. Four display/data correctness defects were reproduced against temporary repositories and a synthetic browser fixture. No authenticated model tests were run. U2, U3 and M4 remain unstarted.

## Changes

1. **Older work omitted from Overview.** The overview previously filtered the newest 200 tasks. It now queries each category before applying its bound, separating execution from queued work. Global counts remain exact; the attention preview shows up to 50 entries, labels an incomplete preview, and links to the full attention-filtered list. The API regression also verifies that 201 queued submissions cannot displace an older running task.
2. **State filters applied only to the current page.** Repeated `state` query parameters form a validated OR filter applied before cursor pagination. The list response includes state counts across the selected project independent of the current page/filter. Switching state groups resets pagination. Request-text search remains deliberately page-local and says so visibly.
3. **Rejected plan labelled approved.** Task detail now includes a read-only `approval` projection from persisted user approval events. Cancellation before approval is not approved; cancellation after approval preserves the historical approval and timestamp. The projection is independent of activity pagination, requires no database migration, and does not change execution authorization. The UI no longer claims the planner's plan was frozen at task submission.
4. **Large evidence lost status fields.** Truncated entries retain a separately bounded `metadata` projection for item/run/agent attribution, validation exit code and execution truncation, and review approval/finding count. The preview body remains bounded text. Activity, work cards and result summaries use structured facts rather than parsing previews. A text preview being truncated does not turn a successful validation into a failure; actual execution-output truncation still does. Reviews with findings never display approval even if their `approved` flag is true.

## Verification

- `npm run check`: passed, 107 tests, zero failed/skipped, backend/UI typechecks and production build.
- New API regressions cover more than 200 historical/queued tasks, multi-state pagination across 52 attention tasks, project-wide counts, invalid state rejection, approval before/after cancellation and beyond the first activity page, and large validation/review payloads.
- Browser suite: the existing nine workflows and three of four new regressions passed in the full run. The remaining new overview test used an exact-text selector against a title containing nested status/project text; the trace confirmed the correct task was visible. After correcting that selector, the targeted overview regression passed. All 13 workflows have therefore passed; there was no production-code change between these browser runs.
- The four new browser regressions cover older active work and the full attention link, state-group paging/cursor reset, rejected versus previously approved cancelled plans, and pass/fail/truncation/review status in large evidence across work/activity/result views.
- `git diff --check`: passed.

Browser screenshots from the existing workflows were written outside the repository using `DEVAGENTS_UI_SCREENSHOT_DIR`; historical screenshots were not overwritten. Docker, protocol, and standalone M2/M3 smoke suites were not repeated in this pass; prior delivery results remain historical evidence. The full check includes orchestration and browser-session API regressions. Authenticated M2/M3 reruns remain pending explicit authorization.

## Scope and limits

The browser remains read-only U1. Overview and task lists are bounded previews/pages, not unlimited downloads. Raw evidence text has a 16 KiB preview (1 MiB single-entry fetch) plus separately bounded metadata; the full text remains on the backend. Activity history still loads by sequence cursors. These fixes do not change the scheduler, agent permissions, credential handling or model execution.
