# DevAgents

DevAgents runs AI development teams on your local Git projects. Agents plan changes, write code, run tests and independently review the result. Follow progress and approve work in your browser.

Work happens in isolated Git worktrees. Results are local commits; DevAgents does not automatically merge or push them.

## Get started

Install and start **Docker with Compose**, clone this repository, then run from its folder:

```sh
./devagents start
```

Choose **Browser** (recommended), **Terminal**, or **Later**. Connect Codex with your ChatGPT account or an OpenAI API key, add a project, and choose a team. Saved connections are reused on later starts.

The first run builds the local image. Later starts reuse it unless the source changed. macOS uses Keychain; Linux requires `openssl`, `secret-tool` and an unlocked desktop keyring.

To change setup later:

```sh
./devagents setup
```

**Available now:** Codex execution. Claude and local-model execution are planned.

[Setup and troubleshooting](docs/SETUP.md) · [Technical reference](docs/REFERENCE.md) · [Roadmap](docs/MILESTONES.md)
