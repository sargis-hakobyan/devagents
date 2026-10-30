# DevAgents browser UI — design source

Static design boards for the local browser UI described in `docs/FRONTEND_BRIEF.md`. They are mockups, not the application: nothing here is served by the service or shipped in the image.

## What is here

- `canvas.json` — the canvas index: every board's file, frame position and size, and canvas notes.
- `Main.dc.html` and `A-*.dc.html` — **Direction A, the chosen direction**: dark indigo band with an amber spark mark, light lavender-grey workspace, Plus Jakarta Sans. The Overview (`Main.dc.html`) uses the denser two-column structure borrowed from Direction B.
- `B-*.dc.html` — Direction B, kept for reference: warm paper workbench with IBM Plex Sans and Plex Mono, dense tables.

Boards per direction: Overview, Tasks, Task detail (running), Teams with the member editor, Projects, Settings, and a states sheet (empty workspace, no teams, missing project, locked connection, unverified model access, loading, disconnected, approval required, failed, narrow 390 px view).

Every example value mirrors the deterministic fixtures (project `fixture`, task "Three modules", items a/b/c, the six built-in roles). Counts and stages are real backend fields; there are no percentages, time estimates or model-availability claims the backend cannot measure. Controls that arrive in U2 or U3 are drawn disabled with a reason.

## Chosen palette (Direction A)

| Token | Value | Use |
| --- | --- | --- |
| ink band | `#231F4A` | header, active navigation, primary buttons, focus ring |
| text | `#1C1A33` | body text |
| muted text | `#5A5F78` | secondary text (4.5:1 on white) |
| background | `#F2F3FA` | page |
| sidebar | `#F8F8FD` | navigation column |
| border | `#E0E2EE` / `#EAECF5` | cards / rows |
| accent | `#FFB703` | spark mark, tab underline, nav badge (never for text on white) |
| attention | `#FFF1DB` / `#7A4A00` / `#B45309` | approval and warning states |
| running | `#E3ECFF` / `#1C3F99` / `#2457C5` | active work |
| success | `#E1F5EA` / `#135E38` | completed, integrated, approved |
| failure | `#FDE8E6` / `#8A1C14` | failed, unresolved |
| link | `#0B7A75` | links |

Status is always text plus an icon; colour alone never carries meaning.

## Editing

Each `.dc.html` file is a self-contained board: plain HTML with inline styles inside an `<x-dc>` wrapper plus a small runtime script. Open a file in a browser to preview it roughly (the `./support.js` runtime is only available on the design canvas, so the `{{ }}` features are unused here and the markup is static).

To reload the whole set on a design canvas, publish `canvas.json` and the `.dc.html` files to a canvas of the Design artifact type with `canvas.json` as the index. The original canvas for this set lives in the owner's claude.ai artifacts as "DevAgents UI directions".

When the implementation (U1 onwards) diverges from these boards, update the boards or note the divergence in `docs/DECISIONS.md`; the boards are the reference for the look, the brief is the reference for behaviour.
