# Review: environment limitations and follow-up handoffs

Reviewed 2026-11-02 on local `main`, HEAD `0123dadef63fa82b3c3b43d322268ab5a3bb38ca`. Scope: `f1429e8`, `8856a66`, `adbd7eb`, `4169b06`, and `0123dad`, in that order. Implementation and handoff findings are distinguished below; the cleanup and dependency-store proposals are not implemented at this HEAD.

The reporting policy is a useful correction and declared validation still gates review. However, reports can disappear across repairs and DAG reviews, and the dependency-store and cleanup handoffs need revisions before implementation. The stronger claim that repository text cannot steer planning is not established by this patch.

## Findings in the reporting implementation

### F1 — P2: Retain limitations from every attempt and item review

Locations: [single-item completion merge](/Users/shakobya/Projects/devagents/src/orchestration/runner.ts:248), [DAG implementation accumulator](/Users/shakobya/Projects/devagents/src/orchestration/dag-runner.ts:82), [item review](/Users/shakobya/Projects/devagents/src/orchestration/dag-runner.ts:139), [DAG final merge](/Users/shakobya/Projects/devagents/src/orchestration/dag-runner.ts:244). Introduced by `f1429e8`.

The single-item loop merges only the final implementation and final review reports. If attempt one reports an unavailable browser and then fails a real test, a successful repair returning no limitations erases that report from the outcome. Earlier rejected-review reports have the same problem. In the DAG path, implementation reports accumulate, but item-review limitations and earlier combined-review limitations never enter that accumulator. An approved item can report a limitation that the final reviewer never receives.

Deterministic reproductions confirmed both cases: a single-item task completed after one real test repair with an empty outcome limitation list despite a report retained in evidence; a two-item DAG completed with no limitations after its first item reviewer reported an unavailable screenshot. The combined review prompt lacked that report. The UI can consequently say “None reported · every declared check ran here.”

Use one bounded task accumulator for implementation and review reports at every stage, carry it into subsequent review context, and merge it into the outcome. Keep report provenance in evidence. Add regressions where only an earlier attempt or item reviewer reports a limitation; existing tests repeat the same report or report only at the final gate and therefore miss this loss.

### F2 — P2: Reconcile the reviewer’s copy-forward instruction with its ten-entry cap

Locations: [copy-forward instruction](/Users/shakobya/Projects/devagents/src/domain/limitations.ts:27), [review schema](/Users/shakobya/Projects/devagents/src/orchestration/outputs.ts:31). Introduced by `f1429e8`.

The reviewer must copy the plan and implementation reports, but its output accepts at most ten entries. A valid plan with ten manual checks and a valid implementation with ten distinct reports already require twenty; a DAG accumulator can independently contain twenty. There is no output that both copies all entries and satisfies this schema. A model constrained to the schema must omit or combine reports; a response containing all twenty fails local parsing and aborts the task.

A direct reproduction merged twenty valid reports and confirmed that `ReviewOutput.safeParse` rejects their copy-forward output. Prefer orchestration-owned carry-forward, with the reviewer returning only newly discovered limitations, or explicitly align the prompt and schema with the aggregate bound. Test more than ten distinct incoming reports.

### F3 — P2: Apply evidence-equivalent redaction to displayed limitation prose

Locations: [outcome persistence](/Users/shakobya/Projects/devagents/src/persistence/store.ts:58), [evidence persistence](/Users/shakobya/Projects/devagents/src/persistence/store.ts:60), [Result rendering](/Users/shakobya/Projects/devagents/ui/src/pages/TaskDetail.tsx:211). The new outcome field exposes the distinction in `f1429e8`.

Limitations use value-only task redaction, while their copies in evidence also use heuristic redaction. A model can quote an unavailable service’s diagnostic containing an otherwise unknown password assignment or bearer token. That text is masked in evidence but survives in `outcome.limitations`; the API’s value-only redaction does not close the gap. Escaping it as HTML text prevents script execution, not disclosure.

A synthetic-only fixture returned `Cannot check service; password=REVIEW_SYNTHETIC_ONLY`. Evidence stored `password=[REDACTED]`; the outcome retained the synthetic value. Known configured secret values and recognized credential shapes are already redacted in both paths. Treat limitation/manual-check display prose with the evidence redactor, without changing code-bearing request or plan fields globally, and test both projections using synthetic values.

### F4 — P3: Cover the connection-check schema and future schema definitions in the walker

Locations: [schema inventory and walker](/Users/shakobya/Projects/devagents/tests/unit/output-schema.test.ts:40), [connection-check model schema](/Users/shakobya/Projects/devagents/src/engines/codex/connection-test.ts:44). Coverage claim added in `8856a66`.

The four workflow schemas are covered, and the `manualChecks.default([])` fix correctly makes the generated property required while preserving local legacy parsing. However, the literal connection-check schema is also sent to the model and is absent from the test. It is valid today; this is a regression-coverage gap, not a current connection failure. The walker also does not visit `$defs`/`definitions`, so moving nested objects behind references could bypass its assertions.

Maintain a shared inventory of every production model schema, include the connection schema, and traverse referenced definitions. New schema call sites must register there; the current manually enumerated test does not discover them automatically.

## Findings in the proposed handoffs

### F5 — P1: Resolve hardlink isolation before implementing the shared-store design

Location: [dependency-store handoff](/Users/shakobya/Projects/devagents/docs/UI_IMPLEMENTATION_PLAN.md:148), from `0123dad`.

The proposed hardlinked install conflicts with three current mechanisms:

- [Preparation tree validation](/Users/shakobya/Projects/devagents/src/workspace/environment.ts:176) rejects every dependency file with `nlink > 1`.
- [Transfer into the worktree](/Users/shakobya/Projects/devagents/src/workspace/environment.ts:118) recursively copies files, losing store hardlinks even if validation were changed.
- [Sandbox scanning](/Users/shakobya/Projects/devagents/src/engines/codex/sandbox.ts:62) denies hardlinked files in both execution modes. The [pnpm wrapper](/Users/shakobya/Projects/devagents/src/engines/node-tools.ts:13) also explicitly forces copy imports.

Merely allowing these hardlinks would create shared writable inodes across worktrees. A write through worker A’s package file can change worker B’s dependencies while B is validating, outside the source diff checks. Repairing integrity on the next install cannot protect the current parallel workers. Similarly, changing `workspaceRuntime` to a project key makes its unconditional [write grant](/Users/shakobya/Projects/devagents/src/engines/codex/sandbox.ts:80) shared by planning/review and execution; a setup-only lock does not make other phases “read-mostly.”

Revise the handoff around an explicit isolation contract, such as independent copy-on-write clones where supported, with a documented fallback, or a genuinely immutable shared package layer. Do not remove general hardlink denial or widen sandbox permissions to make this work. Specify grants and locking for every phase that can mutate the shared runtime. Carry a trusted project identity through preparation/installer/validator interfaces; today the installer receives only a temporary stage path, and `workspaceRuntime` derives identity from the worktree path. Verification needs a simultaneous-worker mutation case, not just repair before a later task.

This is a blocker for the proposed design, not a defect introduced into running dependency preparation by these commits.

### F6 — P1: Refuse cleanup until cancelled workers have fully drained

Location: [cleanup active-task contract](/Users/shakobya/Projects/devagents/docs/UI_IMPLEMENTATION_PLAN.md:174), from `4169b06`; compare [service cleanup](/Users/shakobya/Projects/devagents/src/orchestration/service.ts:137) and [cancellation](/Users/shakobya/Projects/devagents/src/orchestration/service.ts:154).

The handoff allows cancelled tasks and delegates execution to existing `TaskService.cleanup`. Cancellation sets the terminal state synchronously after requesting abort, while the worker promise can still be active. Cleanup checks only terminal state, so a user can preview and remove a worktree while its worker is still draining. HMAC revalidation does not establish that the worker has stopped writing.

A disposable fixture held its implementation call open, cancelled the task, and invoked cleanup before releasing the worker. Cleanup removed one worktree while `runner.busy` remained true. This behavior predates the reviewed commits; the new browser handoff would expose it more directly.

Require a per-task execution/drain check and serialize preview revalidation plus deletion against cleanup and task lifecycle operations. Test cancellation with deliberately delayed worker shutdown. “Active” must mean owned processes/workers remain active, not just membership in a task-state list.

### F7 — P2: Bind the cleanup digest to untracked and staged state too

Location: [preview digest contract](/Users/shakobya/Projects/devagents/docs/UI_IMPLEMENTATION_PLAN.md:174), from `4169b06`.

The preview separates `uncommitted` and `untracked` lists, but the digest explicitly hashes only the uncommitted-file list with blob hashes, branch tips and removal list. It does not explicitly bind untracked content, index content or modes. Editing an existing untracked file without changing its name or size can therefore leave the specified digest unchanged while changing data that `git worktree remove --force` deletes. Staged content can also differ while the working-file bytes and branch tip remain the same.

Define the signed inventory precisely: tracked index and working-tree changes, file type/mode, and the untracked data being removed. Explicitly state the treatment of ignored generated files, which can be large. Include same-size untracked edits and index-only changes in stale-preview tests. Revalidation must cover the actual removal inventory, including run directories, rather than only the visible tracked diff.

### F8 — P2: Define what the saved patch restores before promising base applicability

Locations: [patch creation contract](/Users/shakobya/Projects/devagents/docs/UI_IMPLEMENTATION_PLAN.md:175), [patch verification requirement](/Users/shakobya/Projects/devagents/docs/UI_IMPLEMENTATION_PLAN.md:183), from `4169b06`.

The handoff saves only tracked uncommitted changes but promises a patch that applies to the base commit. In a failed DAG, worker commits and integrated dependency snapshots may already contain substantial work. A tracked uncommitted diff is relative to each worktree’s current index/HEAD, not necessarily the task’s original base. Cleanup deletes failed-task branches, so those commits are not a durable recovery base. Several worktrees may also contain different edits to the same path. Redaction can change context lines, independently preventing clean application.

Specify a patch’s baseline and recovery scope per worktree. Either preserve the necessary base refs, or deliberately produce recoverable base-to-current artifacts that include the work intended to survive; distinguish excluded untracked, binary, oversized and redacted content. Do not label the existing tracked-only redacted artifact a guaranteed backup or guarantee it applies cleanly. Add a failed-DAG case with checkpoint commits and overlapping unfinished edits, plus redaction in patch context.

## Requested assurances and remaining decisions

1. **Planner trust and manual text:** the prompt says repository instructions are untrusted and criteria must be verifiable. This is model guidance, not an enforced property. `validatePlan` checks roles, paths, commands and DAG shape but never relates criterion text to available capabilities. A deterministic probe accepted “Visually verify layout in Chromium and attach a screenshot” alongside `node --test`. It also accepted imperative text in `manualChecks`. The list is bounded to ten strings of 1,000 characters and rendered through escaped Preact text, so it is not an HTML/script execution path. However, the full plan is embedded into review and some repair prompts: JSON encoding does not prevent semantic instruction injection. No live adversarial model test was run, and this review cannot certify immunity to repository steering. Give advisory data an explicit trust boundary in downstream prompts and use structured criterion-to-command/diff evidence associations if enforceable planning guarantees are required.

2. **Validation before review:** confirmed in the single-item runner and both DAG gates. Nonzero exits or truncated validation evidence take the repair path before review; an approving reviewer cannot override them. Review approval also requires an empty findings array, and rejection without findings fails parsing. Environment failures in declared validation still follow the existing setup/failure handling; the new free-form limitation reports do not exempt those commands. Preserve this distinction when fixing the reporting gaps.

3. **Bounds and counts:** `mergeLimitations` trims, removes case-insensitive exact duplicates, caps the aggregate at twenty and slices each entry to 1,000 characters. It does not grow without bound across DAG implementation attempts. Per-run lists are capped at ten. Plan checks are merged first, then implementation and final-review reports, and the event, summary count and detail header all count that same merged outcome array. Thus `describeLimitations` consistently includes manual checks. It counts retained report strings, not distinct semantic checks: reworded duplicates count twice, and more than twenty reports are silently omitted. The Plan tab shows its original list, so its count can differ after deduplication. Consider disclosing truncation and using “reported checks” rather than implying an exhaustive count. F1 and F2 remain material gaps.

4. **Legacy storage/rendering:** no new field is required on stored task objects; `TaskPlan.manualChecks` remains optional, parsing defaults it to `[]`, the store reads existing JSON, and UI accesses use optional guards. Existing outcomes without limitations render without throwing. However, absence of a legacy reporting field is not proof that every possible acceptance check ran: the Result fallback should say “No limitations recorded” rather than infer additional assurance. No migration is necessary for the current shape.

5. **Schema coverage:** all four workflow output schemas pass the strict walker. The omitted connection-check schema and future-definition traversal are covered in F4. No connection check was executed.

6. **Overview and filters:** recommend distinguishing completion with limitations in Recent outcomes and adding a separate “Checks to verify” filter with a server-side count/filter. Keep lifecycle state `completed`; there is no need for a blocked state or to suspend workflow execution. The store already supplies `TaskSummary.limitations` to Overview, but [Recent outcomes](/Users/shakobya/Projects/devagents/ui/src/pages/Overview.tsx:49) ignores it. Current [task filters](/Users/shakobya/Projects/devagents/ui/src/pages/Tasks.tsx:7) use lifecycle states only; a client-only filter over one page would give misleading counts. This is a discoverability recommendation, not a validation-gate defect.

7. **Other handoff feasibility details:** cleanup’s screen placement is compatible with the current UI, and the completed-task diff can remain available after worktree removal because it reads recorded commits through the registered repository. The existing cleanup method removes worktrees and branches only: run-directory ownership/removal and cleanup evidence accounting require new backend work. Existing per-worktree tool runtimes also persist, so define migration/retention separately from the future shared runtime. The store handoff’s claim that run temp data keeps its “existing bounds and removal” is too broad: dependency preparation removes its temporary trees, but the adapter removes only its schema file, and validation run directories are retained. Measure exclusive reclaimable bytes rather than summing apparent file sizes after sharing dependencies; deleting a hardlink does not necessarily free its blocks. Treat the boards’ gigabyte values and “2 GB per task” message as illustrative, not a fixed estimate after shared storage.

## Verification and scope limits

Ran:

```text
node --import tsx --test tests/unit/limitations.test.ts tests/unit/output-schema.test.ts tests/integration/runner.test.ts tests/integration/dag-runner.test.ts
41 tests passed; 0 failed; 0 skipped.
```

Also ran six inline, deterministic checks using disposable fixtures or pure schema functions: single-item report loss after repair; DAG item-review report loss; synthetic redaction mismatch; twenty-entry copy-forward rejection; acceptance of an unverifiable criterion and imperative manual-check text; cleanup while a cancelled fixture worker had not drained. All reproduced the behavior described above. Temporary fixture repositories were removed; no regression test or implementation file was added.

The owner’s reported `npm run check` result (187 tests) and UI result (36 workflows) are prior verification, not reruns by this review. Docker, protocol, M2/M3 suites, authenticated fixtures, browser execution and live-model injection testing were not run. The running service’s reported build from `8856a66` at 15:08 was not inspected or changed. No credentials were inspected, no implementation was modified, no push was made, and M4 was not started. The rejected Chromium/security-option/blocked-state work in `stash@{0}` was neither read nor applied and remains outside the adopted change under review.
