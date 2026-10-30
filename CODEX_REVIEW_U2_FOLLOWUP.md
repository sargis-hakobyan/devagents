# Codex U2 fix-pass re-review

Date: 2026-10-30. Reviewed `1e7bae5` through `7e7d263` on local `main`, against the original U2 implementation at `3e8a475` and `CODEX_REVIEW_U2.md`. Read the implementation and test changes as well as `CLAUDE_REVIEW_U2_FIXES.md`.

**Verdict: close the original F1–F5 and the principal DAG snapshot coverage gap. One new P2 regression, F6 below, needs correction before final U2 editor acceptance.** The model-pinning policy and the pre-existing mode-default idempotency exception remain unchanged.

## F6 — P2: Adding a member during Save silently loses that member

**Location:** `ui/src/pages/Teams.tsx:141–146`; the response overwrites the draft at `ui/src/pages/Teams.tsx:109–110`.

The F3 fix correctly moves navigation and archive actions outside the disabled fieldset. However, it also leaves the Add member menu and both template/custom member actions outside that fieldset, with no `saving` guard. The other editable fields become disabled while saving, but these roster mutations remain usable. A member added after the save request was sent is not in that request. When the response arrives, `setDraft(toDraft(saved))` replaces the newer local draft and `setDirty(false)` marks it clean. The newly added member disappears without a warning or an opportunity to save it.

**Confirmed reproduction against the current built UI:**

1. Open an active three-member team and edit its description.
2. Click Save and hold the outgoing PUT request to simulate a slow response.
3. While Save is pending, open Add member and choose Custom member.
4. Observe four members in the editor, then release the save request.
5. Observe three members again, a success message, and a disabled Save button. The store also contains only the three members from the submitted draft.

Probe output:

```text
While save is pending, Add member disabled: false
Members after adding during save: 4
Members after save response: 3
Stored members after save: 3
Save button disabled after loss: true
```

This is a new regression from `4824fa4`: previously the menu-item buttons were descendants of the fieldset disabled during saving. It affects custom and template additions, including a menu that was already open when saving began.

**Suggested fix:** disable all roster-changing menu items while `saving`, and guard the mutation handler as well. Keep archived-team member selection, Restore and Duplicate usable according to their existing conditions; do not reinstate the original blanket fieldset. Alternatively, explicitly preserve edits made after the submitted draft, but that would require a more complex save-state contract.

**Required regression:** hold a real save request and try both template and custom additions, including an already-open menu. They must be blocked, or their new draft must survive the response and remain dirty. Release the request and verify ordinary additions work again. Retain the F3 archived-detail workflow.

## Original findings and coverage

| Item | Re-review outcome |
| --- | --- |
| F1: typed newlines disappear | **Closed.** Scope fields now retain raw text separately from normalized grants. The new browser test types multiple lines in both scopes, verifies persisted arrays/reload and checks Discard. |
| F2: stale readiness result | **Closed for the reported stale-response/discard cases.** Draft checks use a generation and settle invalidates earlier results on load, save and discard. The regression delays the older invalid check until after the current valid result, and separately across Discard. |
| F3: archived detail controls disabled | **Closed.** Only editable fields are disabled. The new browser test selects another archived member, inspects disabled instructions, restores from detail and re-archives. The changed fieldset scope also introduced the separate F6 above. |
| F4: template instruction truncation | **Closed.** `templates()` copies the complete text. The member limit matches the registry's 64,000-character limit; a separate 192,000-byte total instruction budget rejects oversized rosters explicitly. The test retains a meaningful tail rule past character 16,000 and checks budget rejection. The existing 256 KiB HTTP body limit remains a separate limit on the serialized request, not a promise that every combination of schema-valid fields fits. |
| F5: stricter reviewer independence | **Closed.** Readiness uses the shared role-selection functions to find a distinct implementer/reviewer combination. A reviewer may hold write grants; the same sole worker cannot implement and review its own work. The tests compare readiness with actual plan validation. |
| Successful team-backed DAG | **Principal gap closed.** The new test holds a live worker, revises/archives the team, changes live defaults, then completes three items, combined validation, combined review and the final commit. Assertions verify the original reviewer/instructions, provider ID, runtime-default model setting and per-item scopes. This completes the running task instead of cancelling it. |

The DAG regression uses an unpinned `default` model and changes the default-provider selection by adding another provider. It does not mutate the existing provider definition or demonstrate a pinned-model override through every DAG stage. Those are useful future strengthening cases; the positive running-DAG/combined-gate case requested in the original review is now present. No claim is made that an unpinned runtime model becomes immutable.

## Verification and scope

- `npm run check`: passed on the first re-review run, **122 tests, 0 failures, 0 skips**, backend/UI typechecks and production build. It was run separately from the browser suite to avoid the previously reported load-sensitive overlap assertion.
- `npm run test:ui`: passed, **all 21 browser workflows**, including the new F1–F3 regressions. `DEVAGENTS_CREDENTIAL_RUNTIME` pointed to a newly created empty temporary directory so fixture status used an isolated file store, not the host keychain.
- A separate headless Chromium probe against the real built UI and an in-memory store reproduced F6. It used synthetic authentication and a static synthetic status response, without calling engine health, credential stores or models.
- The original `CODEX_REVIEW_U2.md` is unchanged after `1e7bae5`; this follow-up preserves that report and Claude's fixes record.
- No implementation, tests, roadmap or runtime settings were changed. No authenticated fixtures, real credential inspection, Docker rebuild, push, fetch, pull or branch reconciliation were performed. This report is the only repository addition and remains uncommitted.
- At review start, local tracking metadata reported `main` **ahead 13 / behind 1**, rather than the eleven-ahead count in the handoff. These are local tracking values; no remote refresh was performed.

After F6 is fixed and its regression plus the existing suites pass, U2 can be accepted with the documented limitations. Handle mode-default idempotency as its own compatibility-preserving follow-up before or with U3 submission. Remote reconciliation/pushing and U3/M4 implementation remain separate actions.
