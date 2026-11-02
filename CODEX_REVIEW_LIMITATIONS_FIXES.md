# Review of limitation-reporting fixes and revised handoffs

**Follow-up:** the review below describes HEAD `7cd836b`, before the owner subsequently authorized fixes. The current uncommitted diff addresses R1–R4 in code and R5–R9 in the handoff. See the implementation follow-up at the end; original findings are retained for independent review.

2026-11-02. Reviewed local `main` at `7cd836b7f68a979918b63ad3a7703de42318f976`, covering `ee0842c` and `7cd836b` against the previous review. **Static review only: no tests, probes, fixtures, application code, builds or services were run.** Examples below are code-path deductions, not executed reproductions.

The successful-completion carry-forward paths, reviewer output contract, manual-check storage redaction and five-schema inventory substantially address F1–F4. Remaining defects concern overflow accounting, alternate redaction paths and non-success outcomes. The dependency-layer proposal still has correctness and isolation blockers; cleanup is better specified but its recovery patch still does not preserve distinct staged content.

## Implementation findings

### R1 — P2: Overflow stops deduplicating and the display marker becomes a counted check

Locations: [ledger overflow](/Users/shakobya/Projects/devagents/src/domain/limitations.ts:47), [display formatting](/Users/shakobya/Projects/devagents/src/domain/limitations.ts:29), [summary projection](/Users/shakobya/Projects/devagents/src/persistence/store.ts:176). New behavior in `ee0842c`.

Once fifty entries are retained, `add()` increments `omitted` without inserting the key into `seen`. Consequently, a new 51st report repeated by later workers increments the omitted count each time. For fifty unique retained reports plus the same new report twice, `size` becomes 52 and the marker says 33 omitted, although there are only 51 distinct reports and 32 are omitted. Case-insensitive/redacted duplicates after the cap have the same problem. The current unit coverage uses distinct overflow strings and does not cover this case.

For genuinely distinct reports, the two-cap arithmetic itself is correct: 62 unique reports produce nineteen visible reports and “43 further … omitted.” However, `describeLimitations`, the store, task header, task list and Overview all count the twenty array entries. They announce twenty checks, counting the notice as a check and excluding the 43 omitted checks. At 21 unique reports the same discrepancy starts: nineteen reports plus a notice for two omitted reports, advertised as twenty checks.

Separate report data from display metadata, carrying an explicit total/omitted count. Either deduplicate overflow identities within an explicit resource bound or label overflow as report occurrences rather than unique checks. Do not infer counts from a string array containing a notice. Keeping the notice as ordinary model-input text also lets a model echo it as a newly noticed limitation; a typed metadata field avoids this ambiguity.

### R2 — P2: Raw report objects still bypass ledger redaction on their way to prompts

Locations: [raw output handoff](/Users/shakobya/Projects/devagents/src/orchestration/runner.ts:142), [implementation preview](/Users/shakobya/Projects/devagents/src/orchestration/implementation-evidence.ts:22), [single-item repair feedback](/Users/shakobya/Projects/devagents/src/orchestration/runner.ts:255), [DAG feedback](/Users/shakobya/Projects/devagents/src/orchestration/dag-runner.ts:250). Residual F3 gap.

The ledger redacts a copy; it does not replace `result.output`, `review` or `assessment`. Before the caller adds limitations to the ledger, `invoke()` passes the raw parsed implementation output into `ImplementationEvidence.render()`, whose preview uses only `redactValues`. That supplementary handoff is prepended to the next review prompt. A short limitation containing an unknown synthetic `password=SYNTHETIC_VALUE` therefore remains in this handoff even though the “Recorded limitations so far” section and persisted evidence mask it.

Likewise, rejecting reviews are serialized wholesale into repair feedback. Their raw limitations can reach the implementer through that route after `ledger.add()` has redacted another copy. The adapter's final value-only prompt redaction does not mask arbitrary unknown password assignments. The new regression checks the final review, after the first sensitive report's implementation has already been replaced; it does not assert absence from every prompt or from a rejecting review's repair feedback.

Sanitize limitation fields before any handoff serialization, and construct repair feedback from actionable findings rather than the entire review object. Preserve code-bearing fields deliberately; do not apply heuristic redaction indiscriminately to all code or diffs. Check every immediate review/repair prompt when tests are next authorized.

### R3 — P2: Accepted reports disappear from failed and cancelled outcomes

Locations: [ledger lifetime](/Users/shakobya/Projects/devagents/src/orchestration/runner.ts:213), [failure outcome](/Users/shakobya/Projects/devagents/src/orchestration/runner.ts:317), [DAG error exit](/Users/shakobya/Projects/devagents/src/orchestration/dag-runner.ts:259). Residual F1 gap; unsuccessful-outcome behavior predates these fixes.

Both ledgers remain local to execution and are flushed to `outcome.limitations` only on completion. Consider worker A returning a valid limitation that is successfully added and recorded, followed by worker B failing and aborting the wave. `runDag` throws; the outer runner stores only `{ error, repairCycles }`. The accepted report survives in evidence but is absent from the task outcome. Cancellation and shutdown have the same presentation gap, and the failed/cancelled Result branch never renders limitations even if a later change adds them to the outcome.

Retain the run ledger at a lifecycle boundary accessible to completion, failure and cancellation, and persist already accepted reports after draining without changing the terminal verdict or permitting approval. Display them for unsuccessful outcomes as well, or explicitly narrow the product contract to successful completions. A result returned only after cancellation is different: it is currently rejected by `ensureActive` before parsing and should not automatically count as an accepted report.

### R4 — P2: Other model-generated display prose still uses weaker redaction

Locations: [single-item summary](/Users/shakobya/Projects/devagents/src/orchestration/runner.ts:252), [DAG summary](/Users/shakobya/Projects/devagents/src/orchestration/dag-runner.ts:247), [Plan display](/Users/shakobya/Projects/devagents/ui/src/pages/TaskDetail.tsx:132), [Result summary](/Users/shakobya/Projects/devagents/ui/src/pages/TaskDetail.tsx:205). Pre-existing adjacent issue explicitly included in this review's scope, not a new regression in `ee0842c`.

`outcome.summary` receives `result.summary` or `plan.summary`; Plan renders its summary and risks directly. These fields still go through `Store.taskJson` and the API's value-only redactor. A model quoting an unknown password assignment in those prose fields is masked in its evidence record but displayed unchanged in these projections. Fixing only `manualChecks` and `limitations` does not make all displayed model prose evidence-equivalently redacted.

The Result **review summary is already protected**: it comes from `run-completed` evidence, which uses `Store.json`/`redact`. Keep that path. Establish field-specific display projections for the other prose fields, with explicit handling for text that legitimately contains code. Known configured secret values and recognized token shapes remain protected by the existing value redactor.

## Handoff findings — proposed behavior, not implemented regressions

### R5 — P1: A single shared symlink layout cannot provide task-local workspace sources and caches as specified

Location: [layer layout and substitutions](/Users/shakobya/Projects/devagents/docs/UI_IMPLEMENTATION_PLAN.md:153), from `7cd836b`.

The handoff asserts that relative workspace links resolving inside the layer make the layout work unchanged. The current [preparation stage](/Users/shakobya/Projects/devagents/src/workspace/environment.ts:94) contains dependency metadata and patches, not workspace source. A package dependency on another workspace package normally points to that package's directory. With the installed layout retained in the layer, it resolves to the layer's metadata-only package directory, not the active worker's source. Copying source into the layer instead would pin stale source while the worker edits its own checkout. Relative targets are resolved from the actual link location; entering through a worktree's `node_modules` alias does not rebase links to that worktree.

The cache substitution has the same structural problem. If `worktree/node_modules` is one symlink to the shared layer, a symlink at `node_modules/.cache` belongs to that shared tree. It cannot point to worker A's private cache for A and worker B's private cache for B without a per-worktree view, tool-specific configuration or mount mechanism. A cache link escaping the layer also conflicts with the stated unchanged tree validation.

Specify a per-worktree link/overlay layout for workspace-source references and mutable cache paths, while sharing only immutable external package content. Enumerate actual cache/output paths and their redirection mechanism, including generated package output and tools using real paths. The existing [sandbox scan](/Users/shakobya/Projects/devagents/src/engines/codex/sandbox.ts:61) denies external symlinks, and [scopedPath](/Users/shakobya/Projects/devagents/src/workspace/paths.ts:10) rejects symlinks; adding a read grant for the target alone does not remove those conflicts. Any trusted service-created alias exception must be narrow, identity-checked and separately specified, preserving arbitrary-link and hardlink denial.

### R6 — P1: A setup-only write lock does not freeze the shared tool runtime for readers

Location: [project runtime locking](/Users/shakobya/Projects/devagents/docs/UI_IMPLEMENTATION_PLAN.md:155), from `7cd836b`.

The proposed runtime is writable by setup under a project lock and read-only for implementation/validation/review. That serializes writers, not writers against readers. In a DAG, worker A can finish setup and begin validation while worker B acquires the setup lock and replaces a binary or tool module in the same runtime. A's read-only permission prevents A from writing but does not prevent B from changing what A reads. Existing per-worker preparation in [runDag](/Users/shakobya/Projects/devagents/src/orchestration/dag-runner.ts:70) allows this interleaving.

Publish immutable versioned tool runtimes pinned by every invocation, or define reader/writer leases that exclude setup mutation while any consumer is active. Specify lock ordering with agent slots, preparation and lifecycle locks. Add this setup-versus-validation case to the handoff's future verification; a test that only tries to write from validation does not cover it.

### R7 — P2: Preserve executable bits when publishing an immutable layer

Location: [publication modes](/Users/shakobya/Projects/devagents/docs/UI_IMPLEMENTATION_PLAN.md:152), from `7cd836b`.

The blanket instruction “files 0444” removes execute permission from package binaries and `.bin` shell launchers. Dependencies may be readable while declared commands fail with permission denied. Publish regular data as read-only while preserving legitimate executable bits, for example executable files as 0555, with symlink handling kept separate. Read-only does not require non-executable. This affects the proposed layer even before cache or workspace resolution issues arise.

### R8 — P2: Key dependency reuse by all validated preparation inputs

Location: [layer identity](/Users/shakobya/Projects/devagents/docs/UI_IMPLEMENTATION_PLAN.md:152), from `7cd836b`; compare the [current fingerprint](/Users/shakobya/Projects/devagents/src/workspace/environment.ts:43).

The proposed key names lockfile bytes, package-manager version, Node major and preparation options, but not manifest contents, workspace configuration or patch file contents. Current preparation fingerprints the collected input files and full Node version. A changed manifest with an unchanged lockfile must still trigger frozen-lockfile validation; otherwise an existing layer can hide the mismatch. Changes to workspace metadata or patch bytes can also require a different prepared result even before the lockfile has been updated.

Define “preparation options” concretely and include the canonical validated metadata/patch input digest, plus runtime/platform compatibility dimensions appropriate to native dependencies. Revalidate inputs on a cache hit. Do not turn an existing layer into permission to bypass the current manifest/lockfile consistency checks.

### R9 — P2: A base-to-working-tree patch does not preserve distinct staged edits

Location: [recovery patch contract](/Users/shakobya/Projects/devagents/docs/UI_IMPLEMENTATION_PLAN.md:183), from `7cd836b`.

`git diff <base>` represents the final working-tree content relative to the base; it does not separately archive the index. For a tracked file with base content A, staged content B, and working-tree content restored to A, that patch contains no change. Archiving branch tips preserves commits, not the uncommitted index version B. Cleanup then removes the index; recording its blob hash in preview evidence does not make the blob permanently reachable. The promised “including the index” recovery therefore loses staged-only content in this case.

Either provide distinct base-to-index and index-to-working-tree recovery artifacts, or explicitly exclude preservation of intermediate staged versions and show that exclusion before deletion. Handle conflicted indexes with multiple stages explicitly. Make branch archiving unconditional even when `savePatch=false`; contract 4 currently conditions “recovery artifacts (contract 5)” on that checkbox, while contract 5 includes the archive guarantee. Archive creation and deletion also need crash-safe ordering and collision handling before destructive cleanup is enabled.

## Coverage of the requested edge cases and assurances

**F1 paths.** Integration-conflict repairs use the shared `implement()` helper, so valid reports join the same DAG ledger and survive to successful completion. Item and combined reviews, including rejecting reviews, add reports before the approval decision; this fixes the originally reproduced losses. Ledger mutation is synchronous with no intervening await, so parallel callbacks do not overwrite each other's lists. However, the ledger is not created before *all* report-capable phases: the workflow's [prepare-environment step](/Users/shakobya/Projects/devagents/src/orchestration/workflows.ts:63) precedes `execute`, where the single-item ledger is constructed. `SetupOutput` has no limitations field, and setup summaries are not ingested during initial setup or recovery. A successful setup can mention an unavailable optional check in its summary and a later successful task still has no ledger entry for it unless another model repeats it. Define a structured setup report path if those reports are meant to share the policy; do not infer limitations from arbitrary failure prose or waive failed declared validation. Aborted-sibling and non-success persistence are R3.

**Evidence provenance.** Single-item limitation evidence includes zero-based `attempt`. DAG limitation evidence includes phase and work-item ID but neither attempt nor run ID ([implementation](/Users/shakobya/Projects/devagents/src/orchestration/dag-runner.ts:82), [review](/Users/shakobya/Projects/devagents/src/orchestration/dag-runner.ts:116)). The commit/decision claim that every report has phase and attempt is too broad. Surrounding run events can be inspected, but add an explicit run/attempt correlation for repeated item reviews and integration-conflict repairs. Planner checks are seeded rather than emitted as standalone limitation evidence; the planning run/plan retains them.

**F2 bounds and validation.** The reviewer now reports newly noticed limitations only, resolving the original impossible ten-entry copy-forward requirement. The ledger keeps at most fifty strings and fifty dedupe keys, and its returned list stays within twenty entries of at most 1,000 characters. R1 concerns truthful counting, not unlimited retained memory. `mergeLimitations` now walks/retains all input uniques before returning a bounded list; its production caller supplies at most fifty entries, so no current unbounded input route was identified. Declared validation still precedes every review gate; ledger contents do not bypass nonzero/truncated validation or authorize a commit with findings.

**F3 boundary.** `proposePlan` is a suitable boundary for newly stored manual checks: it parses the planner output, sanitizes those prose fields, and later planning consumers receive the stored plan. The earlier `run-completed` planner record already uses evidence redaction. It does not retroactively sanitize existing stored plans or close the alternate report paths in R2. Displayed strings remain escaped text; no HTML execution sink was introduced.

**F4 inventory.** Static search for `schema:`, `outputJsonSchema`, `text.format`, `output_schema`, `response_format` and engine call sites found all five production model schemas in `modelSchemas()`. The connection check imports its registered literal, and the walker now descends into `$defs` and `definitions` with a negative self-check. Mastra workflow schemas are orchestration state, not model outputs. There is one separate literal in [codex-protocol-smoke.mjs](/Users/shakobya/Projects/devagents/scripts/codex-protocol-smoke.mjs:49), used by the explicitly deterministic loopback protocol fixture, not a production model call. No unregistered production schema was found. Registration remains a convention: `invoke(schema: z.ZodType)` and the adapter accept arbitrary schemas, so the exact-five inventory assertion cannot detect a future unregistered call site. A typed schema key at the model boundary would make that requirement enforceable.

**Prompt trust boundary.** Review now clearly labels recorded lists and plan data as non-instructions. Planning already says repository instructions are untrusted, but `validatePlan` still does not establish semantic verifiability of acceptance text. The implementer does not receive plan-level manual checks in the ordinary single-item prompt, but DAG conflict and combined repairs embed the full plan, and rejecting-review feedback embeds limitations. They lack the new review-side data boundary. Label advisory/manual reports consistently and separate findings to repair from advisory reports; ideally omit manual checks from implementation instructions entirely. Setup summaries also need explicit claim/data framing. These are static trust-boundary observations, not proof of a successful model injection or a guarantee that wording alone prevents one.

## Additional handoff details to settle before implementation

- **Drain and lock lifetime:** the revised terminal-and-drained requirement addresses the original F6 conceptually. Current `TaskWorkflows.parallel()` catches worker failures and joins siblings before propagating failure; `runProcess` waits for child close and terminates its process group. A future `drained(taskId)` must account for these promises, nested loop/wave runs and process cleanup, not just task state or persisted workflow status. Persisted child statuses can be stale after restart. Do not hold the new lifecycle mutex for the entire run if cancel needs that same mutex to signal abort; specify short state-transition critical sections and await drain without blocking the operation that releases it. Current cleanup code still lacks these proposed protections, as expected for a documentation-only revision.

- **Preview hashing:** the revised inventory explicitly covers untracked content and index state, improving F7. Specify a separate bounded read/hash of tracked working-tree contents: porcelain-v2 status reports HEAD/index object IDs, not a ready-made working-tree blob hash. Preserve all relevant modes and conflict stages. `runs: [{path,bytes}]` is not by itself a recursive file inventory; define entries/types so same-total-size directory changes cannot evade the promised new-file detection. Ignored content is deliberately only counts/bytes, so clarify that “binds everything” does not mean content identity for ignored files. Keep shared layers/runtime directories out of task removal inventories, and never follow worktree dependency links during size measurement or deletion. Service locks do not prevent an external local process from editing a worktree; state the remaining race boundary honestly.

- **Runtime and setup integration:** writable per-worktree HOME/cache locations are still needed when the shared tool runtime becomes read-only. The present [adapter](/Users/shakobya/Projects/devagents/src/engines/codex/adapter.ts:51) and validator set HOME directly to the runtime. The handoff needs an actual request/response path for “asks preparation to rebuild”: `SetupOutput` currently supplies only `ready` and `summary`, and the setup prompt permits direct installs. Script-free immutable layers also need an explicit compatibility path for dependencies requiring lifecycle/native builds; silently removing those prerequisites from default-mode setup would regress supported projects. The npm copy/cache exception should be separated from general “nothing is copied” claims.

- **Archive retention:** archive refs initially reuse existing Git objects but keep them reachable indefinitely, preventing later reclamation. Define visibility, accounting and an explicit owner-controlled retention/prune policy; “at no extra disk cost” is misleading over time. `savePatch=false` must not disable the promised archive retention. The recovery paragraph also literally says both “Two copies are kept” and that no unredacted copy is kept; remove that contradiction. Clarify whether oversized hunks are excluded or cause a 413, and ensure the whole task refuses before any destructive step if any requested patch exceeds the limit.

## Verification status and repository impact

Read source, commit diffs, handoff text and regression-test source only. The new tests cover successful multi-repair retention, item-review propagation, initial redaction and distinct-entry bounds; their execution results were not independently verified. The owner's reported `npm run check` (189 tests) and `npm run test:ui` (36 workflows) remain prior verification supplied with the request.

No test command or inline reproduction was run. No implementation changes, push, Docker rebuild, authenticated fixture, credential inspection, stash access or M4 work occurred. The running service's reported 15:08 build from `8856a66` was not inspected or altered. The only workspace change made by this review is this report; the previous review report was left unchanged.


## Implementation follow-up for Claude

The owner subsequently authorized fixing the findings locally. Review the uncommitted diff against `7cd836b`, using R1–R9 above as the checklist. R1 has separate count/omission metadata and bounded hash deduplication; historical omission notices produce conservative lower-bound counts. R2/R4 sanitize report/display prose before reuse and on legacy reads; repair prompts include findings only. R3 now captures setup and all accepted invocation reports into a run ledger before they can be lost on later failure, checkpointing outcomes and retaining them after cancellation/drain. DAG provenance includes run ID and per-phase attempt. Declared validation still precedes review. Prompt data-boundary wording is shared across phases; it does not prove semantic verifiability of model-generated criteria.

R5–R9 revise only the dependency-store and cleanup contracts, including private worktree views, immutable runtime generations, complete input keys, preserved executable bits, short drain-safe locking, explicit content inventories, unconditional archived branch tips and two recovery-patch components. The schema inventory still contains the five production schemas; setup's new limitations field is part of its existing registered schema. Registration of future call sites remains a convention.

Added regression source covers overflow deduplication/counts, redaction in immediate prompts and displayed prose, initial setup/recovery, conflict-repair reports, sibling failure and cancellation. Backend/UI TypeScript checks passed; tests were deliberately **not run**. No commit, push, Docker rebuild, authenticated fixture, credential inspection, stash access or M4 work was performed. The historical review's repository-impact statement above refers to the review phase only.

Concurrent changes appeared in `design/ui/U4-Cleanup-Task.dc.html` and `design/ui/U4-Cleanup-Lists.dc.html` during this work. Those edits were not made or changed by this implementation pass. They add a compaction tier beyond the reviewed removal handoff; review their alignment separately rather than treating them as part of the R1–R9 fixes.
