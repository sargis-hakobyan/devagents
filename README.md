# DevAgents

DevAgents uses Mastra workflows to run AI development teams on your local Git projects. Agents plan changes, write code, run tests and independently review the result. Follow progress and approve work in your browser.

Completed tasks include a read-only diff with GitHub-style green additions, red deletions, blue hunk headers and coloured file counts.

Each new task starts from the current local `main` commit in a clean, isolated Git worktree on its own `devagents/<request>-<id>` branch. Other branches and uncommitted files are not copied. Results are local commits; DevAgents does not automatically merge or push them.

Separate agent QA is disabled by default (`qaEnabled: false`); use your CI pipeline for QA verification. Developer validation and independent code review remain enabled. If explicitly enabled with `qaEnabled: true`, an independent QA engineer is assigned from the task's frozen team. After validation (and integration for multi-item tasks), QA verifies each required acceptance criterion before final code review and commit. QA defects use the existing bounded repair loop; every repaired result is checked again. Teams without an enabled QA agent record an explicit skip. Historical tasks are not retroactively marked QA-verified.

Optional checks that cannot run inside the sandbox (a browser, a GUI, network services, manual QA) are reported with the result as "not run in this environment" instead of being retried; repair cycles are spent only on failing tests and code defects. A required acceptance criterion that QA cannot verify stops the task without a final commit and reports the missing prerequisite. Typecheck and lint are not proof that visual or interactive behavior works. See [the decision record](docs/DECISIONS.md#environment-limitations-are-reported-not-repaired--2026-11-02).

By default, the coding agent prepares project tools, dependencies and setup scripts before coding. Optional extra rules enable restricted preparation. See [environment preparation and limits](docs/SETUP.md#project-environment-preparation).

## Get started

Install and start **Docker with Compose**, clone this repository, then run from its folder:

```sh
./devagents start
```

Choose **Browser** (recommended), **Terminal**, or **Later**. Connect Codex with your ChatGPT account or an OpenAI API key, and add a project. A ready-made starter team is selected automatically; customize it anytime in Teams. Saved connections are reused on later starts.

New starter teams contain a **Tech Lead**, **Frontend Developer**, **Backend Developer** and **Code Reviewer**. The lead defines contracts and assigns independent frontend/backend items to run in parallel (the default worker limit is two); backend also handles tooling and integration. On a task's **Work** tab, the team board shows both developers working, their assigned items and separate activity links. Genuine dependencies still wait. Existing saved teams keep their revisions; add the specialists in Teams to update an older roster. Already submitted tasks retain their original team snapshot.

The first run builds the local image. Later starts reuse it unless the source changed. macOS uses Keychain; Linux requires `openssl`, `secret-tool` and an unlocked desktop keyring.

To change setup later:

```sh
./devagents setup
```

Extra DevAgents restrictions are off by default; [enable them in setup](docs/SETUP.md#optional-devagents-rules) when needed. The engine sandbox remains active.

**Available now:** Codex execution. Claude and local-model execution are planned.

[Setup and troubleshooting](docs/SETUP.md) · [Technical reference](docs/REFERENCE.md) · [Roadmap](docs/MILESTONES.md)


Successfully completed tasks automatically release ignored dependencies, private tool caches and owned run scratch after workers stop, and again during startup recovery. Clean completed worktrees are then removed; reviewed result branches, commits and history remain available. Worktrees with local edits or extra files are retained. Set `DEVAGENTS_COMPACT_COMPLETED_TASKS=false` to opt out. For failed or cancelled tasks, use **Preview task compaction** to reclaim regenerable resources while keeping unfinished work. Dependencies and tools must be prepared again before running checks in a compacted worktree. See [storage recovery](docs/REFERENCE.md#storage-recovery-and-task-compaction).
