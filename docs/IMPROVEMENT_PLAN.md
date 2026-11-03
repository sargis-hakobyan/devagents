# Improvement plan — after reviewing Paperclip (2026-11-02)

Source: a read of [paperclipai/paperclip](https://github.com/paperclipai/paperclip) (README, product definition, V1 execution contract, execution semantics, review guide, roadmap) against DevAgents at `7cd836b`. Paperclip is a control plane for a company of agents that it does not run itself; DevAgents is a single-user local orchestrator that runs agents inside a sandbox with real validation and independent review. Most of Paperclip's surface (heartbeats, org chart, budgets across companies, Postgres, multi-tenant RBAC) does not transfer, and its isolation stance (local adapters run unsandboxed; the OS owns file access) is weaker than ours. A few of its operating rules address the problems met this week. This plan orders them; Codex implements, Claude designs. Boards: `design/ui/U4-Cleanup-*.dc.html` (revised) and `design/ui/U5-*.dc.html`.

Standing rules carried into every item: declared validation failure cannot be waived; nothing is retried silently; nothing is deleted automatically; environment limitations are reported, not repaired; task history is never removed; the model-pinning policy is unchanged; M4 is out of scope.

## 1. Compaction before removal (cleanup tier 1)

Learned from: Paperclip compacts terminal worktrees before archiving — generated dependency, build and cache directories go, the workspace, branch and source changes stay, and reuse regenerates them.

Why first: it solves the disk problem that failed task `8b226d62` without the patch and archive-ref machinery, and it keeps a failed task's unfinished edits readable on disk.

Contract (extends the cleanup handoff in `UI_IMPLEMENTATION_PLAN.md`; the removal tier there stays as tier 2):
- `GET /tasks/:id/compaction-preview`: for each owned worktree, the generated directories the service recognises (ignored by Git **and** in the recognised set: `node_modules` at any depth, `.next`, `.turbo`, `.vite`, `dist`/`build` only when ignored, `coverage` only when ignored, `node_modules/.cache`, `.eslintcache`, `.paraglide` outputs, plus the project's declared generated paths) with sizes; ignored-but-unrecognised paths listed as kept with sizes; the run temp directories; a digest over that inventory with the same HMAC rule as the removal preview.
- `POST /tasks/:id/compact` `{ digest }`: terminal-and-drained under the per-task mutex (same rule as removal), recompute, compare, delete only the listed generated directories, record `compaction` evidence with bytes freed and the list, mark the worktree compacted. Tracked files, untracked files, the index, the branch and item branches are untouched; a compacted worktree still opens in Git and in the read-only diff.
- Reuse: preparation of a task that reuses a compacted worktree regenerates the deleted directories from the dependency layer (plan item 5 of the store handoff) or by a fresh locked install; "Submit a new task from this request" may offer "reuse this worktree" only once the dependency layer exists.
- UI: task header button "Compact · frees N GB, keeps your edits"; Result tab "Working files" row with both tiers; Tasks "Holding files" bar with "Compact all" as the primary action and "Remove the selected" as the second; after-compaction rows per the U4 boards.
- Tests: compaction deletes exactly the recognised ignored directories and nothing tracked, untracked or unrecognised; a same-size edit in an untracked file does not invalidate compaction (it is kept, not deleted) but a new unrecognised ignored directory does change the inventory; drained/active refusals; a compacted worktree still yields the completed task's diff and can be prepared again; hostile directory names render as text.

## 2. Liveness rule, silent-worker watchdog and attention surface

Learned from: Paperclip's invariant that every non-terminal task must have a live execution path, an explicit waiting path or an explicit recovery path; stalls are surfaced, retries are bounded, tool calls are never replayed, exhaustion opens a visible item.

What changes:
- **Watchdog.** The runner records the time of the last engine event per active run. When a phase has produced no event for `silenceWarningMs` (default 10 min, config), the task gets a derived attention fact `{ kind: 'silent', since, lastEvent, timeoutAt }` exposed on summaries and detail. No new lifecycle state: the task stays `running`/`validating`; the fact disappears when an event arrives. The existing execution timeout remains the hard stop.
- **Attention surface.** The Overview's "Needs your attention" card lists, in order: silent workers, decisions (mode, approval), recoveries. Each row names the measured fact and offers only permitted actions: "Keep waiting N min" (extends `silenceWarningMs` for that run once; recorded), "Cancel task…", "Review plan", "Retry now". The task header shows the same chip and actions. The nav badge counts all three kinds.
- **Bounded automatic recovery, made explicit.** Provider quota or capacity errors during planning/implementation: one automatic retry after the provider's stated delay (bounded by `executionTimeoutMs`), recorded as `recovery` evidence; a second failure becomes a `recovery_needed` attention row with "Retry now" (a fresh run, never a replay) and "Cancel". Lost dispatch after a restart: one continuation of a task that was waiting (`awaiting_mode`, `awaiting_plan_approval`, `ready`), as `recover()` does today, made visible in the row. Everything else keeps today's behaviour: declared-validation failures use the repair budget, limitations are reported, cancelled/interrupted/unknown errors are terminal.
- **Non-goals:** no restart of a silent worker, no model switching on failure, no retry of Git failures, no comments-as-liveness.
- Tests: a fake engine that stops emitting events makes the attention fact appear at the threshold and disappear on the next event; "Keep waiting" extends once and is recorded; cancel from the attention row drains the worker; a quota error retries exactly once with the recorded reason and then surfaces; restart recovery wakes a waiting task once; the Overview orders rows as specified; attention counts match the store.

## 3. Answer-only work mode

Learned from: Paperclip's `ask` work mode (answer only, no implementation) and `planning` mode, distinct from `standard`.

What changes:
- `TaskInput.kind: 'change' | 'answer' | 'plan'` (default `change`; stored on the task; part of the idempotency fingerprint). `answer`: the planner's lead investigates in the task worktree with the sandbox read-only, no dependency preparation, and returns `AnswerOutput { answer, citations: [{ path, line?, note }], confidence: 'high'|'medium'|'low', limitations }` (strict schema, registered in `modelSchemas()`); the reviewer checks citations resolve and the answer addresses the request; approval completes the task in a new terminal state `answered` (terminal, no commit, no repair beyond one review cycle). `plan`: today's planning through approval, then the task stops at `awaiting_plan_approval` with "Approve and run" turning it into a change task with the same plan version, or "Keep as plan" completing it as `planned`.
- Readiness: answer tasks need an enabled planner and a reviewer; implementers are not required (a draft team with a planner and a reviewer can answer).
- UI: a "What kind of work" group on the submit form above Autonomy; the task page renders the answer with citations as text and links to the diff viewer's file view when the task's base commit is readable; "Submit this as a change" prefills a new change task from the answer (new key).
- Tests: an answer task produces no worktree writes, no preparation and no commit; a citation to a missing path is a review finding; idempotent retry of the same answer input returns the task; the kind cannot be changed after submission; plan tasks stop at approval and convert without re-planning.

## 4. Cost rollups and an optional project budget

Implemented subset (2026-11-03): the task Usage tab and authenticated usage endpoint derive per-step/attempt tokens from evidence, include cache counts, snapshot new-run pricing and distinguish estimated API cost from API-equivalent estimates. USD and dated EUR conversion are available. Missing measurements/models are explicit. No separate usage table, project/monthly rollups or budgets have been implemented. The bullets below retain the broader planned scope.

Learned from: Paperclip's cost events attached to every run and rolled up per company, agent, project and model, with monthly budgets that pause at 100 %.

What changes:
- Usage already recorded in `run-completed` evidence becomes a `usage` row per run `{ taskId, runId, phase, agentId, model, inputTokens, outputTokens, reported: boolean }`; a run with no provider usage is `reported: false` and counted separately, never estimated.
- Config `pricing: { <model>: { inputPer1M, outputPer1M, currency } }` optional; cost is computed only for priced models; unpriced runs show tokens only.
- Rollups: per task (header and Activity tab table), per project and per month (Overview "Spend" card), with the count of unreported and unpriced runs shown beside every total.
- Optional `budgets.monthly` per project: at 100 % new submissions for that project are refused with the reason and the Overview shows the budget chip; running tasks finish. No automatic pause of anything running, no agent-level budgets.
- Tests: totals equal the sum of evidence; unreported runs excluded and counted; unpriced models produce tokens-only totals; budget refusal at submission with an actionable message; month boundary in UTC.

## 5. Smaller rules to adopt as they are

- A decision (approve, reject, cancel from the browser) carries a non-empty comment, recorded in the event reason. (Paperclip: mandatory decision comments.)
- One activity stream: project registration, default-team changes, team edits and archives, cleanup and compaction, budget changes are recorded as events with actor, before and after, in the same table task transitions use, and listed on a Settings "Activity" card. (Paperclip: every board mutation writes to the activity log.)
- "Report anything you could not run and why" is already the policy; keep it in the planner, implementer and reviewer prompts and in the result.

## 6. Later, not now

- Provider session continuity across repair cycles (resume the Codex session instead of re-prompting), after measuring token savings.
- Intake connector for loop-ui feedback items: feedback → task with milestone comments back; treat imported text as untrusted, never as instructions.
- Work products as first-class result attachments (screenshots, previews) once a browser exists in the sandbox; until then limitations are the honest counterpart.

## Order and dependencies

1 (compaction) and 2 (liveness) are independent and come first; 2 has no dependency on cleanup. 3 (answer mode) depends on the schema inventory (done) and adds a terminal state, so it lands after 2 so that answer tasks get the same attention handling. 4 (costs) is independent and small; the budget gate depends on rollups. The dependency layer (store handoff) makes compaction's regeneration cheap but is not a prerequisite; compaction with a fresh locked install is acceptable first.

Each item ships with the regression tests listed, `npm run check`, the browser suite, and a Docker smoke when preparation or sandbox code changes. Nothing here authorizes authenticated model calls.
