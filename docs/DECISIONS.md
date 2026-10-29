# Decision log

## User-confirmed choices — 2026-10-29

- Register existing local Git checkouts by absolute path; mount each explicitly in Docker. Do not clone/import.
- Implement Codex first. Keep coding runtimes separate from inference providers and models.
- Offer API keys and officially supported login flows, with provider-specific restrictions visible.
- Provide named built-in roles and YAML/Markdown custom agents with descriptions, instructions, model/provider selection and permissions.
- Local inference is a follow-up phase, with extensible configuration from the start.
- Existing remote resolves repository owner: `sargis-hakobyan/devagents`. Keep Apache-2.0.

## First implementation increment — 2026-10-29

- Strict TypeScript, Zod, Node 24 SQLite, native HTTP API and CLI client; no custom UI.
- Transactional state/events, idempotent submissions and optimistic approval versions.
- Private data-directory bearer token; browser-origin requests rejected; loopback host publishing.
- Registry precedence project > user > built-in. Definitions are data, never executable packages.
- Mastra compatibility proven separately; domain storage stays framework-independent.
- Worktrees begin from committed HEAD; dirty user changes stay untouched in the original checkout.
- Execution, push, merge and deploy stay disabled in M1. `ready` means a durable plan checkpoint, not a completed coding task.
- Dedicated Codex profile with no host-home/credential copying or Docker socket mount.
- Recovery marks interrupted execution failed for inspection; no automatic replay of side effects.
