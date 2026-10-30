import { resources } from '../api';
import { Card, Chip, Code, Empty, ErrorNote, Later, Skeleton } from '../components/ui';
import { formatTime } from '../format';
import { usePoll } from '../state';

export function TeamsPage() {
  const agents = usePoll(resources.agents.key, resources.agents.load, resources.agents.intervalMs);
  const list = agents.data ?? [];
  const planner = list.some(a => a.enabled && a.delegation.canDelegate && a.capabilities.includes('planning'));
  const implementer = list.some(a => a.enabled && a.delegation.canReceiveTasks && a.permissions.writePaths.length > 0);
  const reviewer = list.some(a => a.enabled && a.delegation.canReceiveTasks && a.capabilities.includes('review') && a.permissions.writePaths.length === 0);
  return <>
    <div class="page-head"><div><div class="h">Teams</div><h1>Teams</h1><p>A team is a saved, named roster you reuse across projects. It is configuration, not a running process.</p></div><Later label="New team" increment="U2" reason="Saved teams arrive in U2" primary /></div>
    <div class="note info"><b>Saved teams are not available yet (planned for U2).</b> Below is the agent configuration the service resolves today from YAML and Markdown files, in the order built-in → user → project. Nothing here is a persisted team, and these cards do not create processes.</div>
    {agents.error && !agents.data && <ErrorNote message={agents.error} />}
    {!agents.data ? <Skeleton rows={4} label="Loading agents" /> : <Card title={`Current agent configuration · ${list.length} agents`} right={<span class="muted" style={{ fontSize: '12.5px' }}>precedence built-in → user → project</span>}
      foot={<span style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>{planner && implementer && reviewer ? <Chip tone="ok">✓ Ready to run work</Chip> : <Chip tone="warn">⚠ Not ready</Chip>}<span>{planner ? 'planner ✓' : 'no planner'} · {implementer ? 'writable implementer ✓' : 'no writable implementer'} · {reviewer ? 'independent reviewer ✓' : 'no independent reviewer'} · re-checked at submission and plan time</span></span>}>
      {list.length === 0 ? <Empty title="No agents resolved" /> : <div class="items" style={{ padding: '14px' }}>{list.map(a => <article key={a.id} class="card item">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}><b>{a.name}</b>{a.enabled ? <Chip tone="ok">Enabled</Chip> : <Chip tone="neutral">Disabled</Chip>}</div>
        <div class="muted wrap-anywhere" style={{ fontSize: '13px' }}>{a.description}{a.delegation.canDelegate ? ' · delegates, does not receive tasks' : ''}</div>
        <div class="stages">{a.capabilities.map(c => <Chip key={c} tone="neutral">{c}</Chip>)}</div>
        <div class="muted mono wrap-anywhere">{a.engine === 'default' ? 'codex (default)' : a.engine} · {a.provider === 'default' ? 'openai (default)' : a.provider} · model {a.model} · {a.permissions.writePaths.length ? `write ${a.permissions.writePaths.join(', ')}` : 'read only'} · shell {a.permissions.allowCommands ? 'on' : 'off'} · concurrency {a.concurrency}</div>
        <div class="muted" style={{ fontSize: '12px' }}>source <span class="mono wrap-anywhere">{a.source.replace(/^.*\/agents\//, 'agents/')}</span></div>
      </article>)}</div>}
    </Card>}
  </>;
}
export function ProjectsPage() {
  const projects = usePoll(resources.projects.key, resources.projects.load, resources.projects.intervalMs);
  const status = usePoll(resources.status.key, resources.status.load, resources.status.intervalMs).data;
  const docker = status?.service.dataDir === '/data';
  return <>
    <div class="page-head"><div><div class="h">Projects</div><h1>Registered repositories</h1><p>Existing Git checkouts registered by absolute path. Work happens in managed worktrees; the original checkout is never modified.</p></div><Later label="Register repository" increment="U3" reason="Browser registration arrives in U3. CLI: devagents projects add <id> <absolute-path>" primary /></div>
    {projects.error && !projects.data && <ErrorNote message={projects.error} />}
    {!projects.data ? <Skeleton rows={3} label="Loading projects" /> : projects.data.length === 0 ? <Card><Empty title="No projects yet"><span>Register an existing Git checkout by its absolute path. DevAgents never clones or imports.</span><Code>devagents projects add my-project /absolute/path</Code></Empty></Card> : <div class="items" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))' }}>{projects.data.map(p => <article key={p.id} class="card item" style={{ padding: '18px 20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}><b style={{ fontSize: '17px' }}>{p.id}</b><Chip tone="ok">✓ Registered Git root</Chip></div>
      <div class="mono wrap-anywhere">{p.path}</div>
      <dl class="kv" style={{ gridTemplateColumns: '150px minmax(0, 1fr)' }}>
        <dt>Registered</dt><dd>{formatTime(p.registeredAt)} · base <span class="mono">{p.baseSha.slice(0, 7)}</span></dd>
        <dt>Default mode</dt><dd>{p.defaultMode ?? <span class="muted">None · each task asks once</span>}</dd>
        <dt>Default team</dt><dd><span class="muted">None · legacy agent configuration</span> <Chip tone="neutral">set in U2</Chip></dd>
        <dt>Path check</dt><dd class="muted">Verified at registration; live access diagnostics arrive with U3 registration.</dd>
      </dl>
      <a href={`/ui/tasks`} style={{ fontWeight: 700, fontSize: '13.5px' }}>History →</a>
    </article>)}</div>}
    <Card title="How registration works"><div style={{ padding: '14px 16px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '18px' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}><b>Native</b><span class="muted" style={{ fontSize: '13.5px' }}>Register the absolute path of an existing checkout. The service validates that it is a Git root with at least one commit and that the path has not moved.</span><Code>devagents projects add website /absolute/path/to/website</Code></div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}><b>Docker{docker ? ' (this service)' : ''}</b><span class="muted" style={{ fontSize: '13.5px' }}>Mount the checkout explicitly in <span class="mono">compose.override.yaml</span>, then register its <b>container</b> path. Home directories and the Docker socket are never mounted; there is no filesystem browser.</span><Code>docker compose exec devagents node dist/cli/main.js projects add website /projects/website</Code></div>
    </div></Card>
  </>;
}
export function SettingsPage() {
  const { data: status, error } = usePoll(resources.status.key, resources.status.load, resources.status.intervalMs);
  if (!status && error) return <ErrorNote message={error} />;
  if (!status) return <Skeleton rows={6} label="Loading settings" />;
  const c = status.codex;
  return <>
    <div class="page-head"><div><div class="h">Settings</div><h1>Connection, engine and limits</h1><p>Read-only in U1. Values come from the running service; edit <span class="mono">devagents.yaml</span> and restart, or use the terminal setup below.</p></div></div>
    <Card title="Codex connection" right={<span style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>{c.vaultLocked ? <Chip tone="warn">⚠ Credentials locked</Chip> : c.signedIn ? <Chip tone="ok">✓ Sign-in saved</Chip> : c.installed ? <Chip tone="warn">⚠ Not signed in</Chip> : <Chip tone="bad">✕ Not installed</Chip>}<Chip tone="warn">⚠ Model access not verified</Chip></span>}
      foot={<span style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}><Later label="Change sign-in" increment="U3" reason="Guided browser setup arrives in U3; use the terminal flow" /><Later label="Test connection" increment="U3" reason="Opt-in paid test; arrives with U3 and always asks first" /><span>Terminal setup today: <Code>npm run cli -- auth setup</Code> or <Code>./devagents start</Code></span></span>}>
      <div style={{ padding: '14px 16px' }}><dl class="kv">
        <dt>Runtime</dt><dd>{c.installed ? `${c.version ?? 'Codex'} · installed · dedicated profile` : 'Codex CLI not found on PATH'}</dd>
        <dt>Credential store</dt><dd>{c.credentialStore === 'keyring' ? 'OS keychain (native).' : 'Encrypted vault in the data volume, unlocked by ./devagents start.'} Secrets are never shown here; a replacement is write-only.</dd>
        <dt>Model access</dt><dd>A saved sign-in does not establish quota or access to every model. The optional connection test sends one small request on your allowance; it never runs automatically.</dd>
        <dt>Claude Code</dt><dd>{status.claude.installed ? `Installed ${status.claude.version ?? ''}` : 'Not installed'} · <Chip tone="neutral">Not enabled · {status.claude.note}</Chip></dd>
      </dl></div>
    </Card>
    <div class="items" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' }}>
      <Card title="Engine and model defaults"><div style={{ padding: '14px 16px' }}><dl class="kv" style={{ gridTemplateColumns: '140px minmax(0, 1fr)' }}>
        <dt>Default engine</dt><dd class="mono">{status.defaults.engine}</dd>
        <dt>Default provider</dt><dd class="mono">{status.defaults.provider}</dd>
        <dt>Default model</dt><dd>runtime default (not pinned)</dd>
        <dt>Providers</dt><dd>{status.defaults.providers.map(p => <div key={p.id} class="mono">{p.id} · {p.kind} · {p.auth}{p.apiKeyConfigured !== null ? ` · key ${p.apiKeyConfigured ? 'configured' : 'missing'}` : ''}{p.executable ? '' : ' · configuration only'}</div>)}</dd>
      </dl><div class="muted" style={{ fontSize: '12.5px', marginTop: '8px' }}>Per-agent overrides resolve against these defaults.</div></div></Card>
      <Card title="Execution limits"><div style={{ padding: '14px 16px' }}><dl class="kv" style={{ gridTemplateColumns: '170px minmax(0, 1fr)' }}>
        <dt>Global concurrency</dt><dd>{status.limits.concurrency} work items per wave</dd>
        <dt>Repair cycles</dt><dd>{status.limits.maxRepairCycles} per item · {status.limits.maxRepairCycles} shared for integration</dd>
        <dt>Execution timeout</dt><dd>{status.limits.executionTimeoutMs / 1000} s per engine run</dd>
        <dt>Validation timeout</dt><dd>{status.limits.validationTimeoutMs / 1000} s per command · output capped at 1 MiB</dd>
        <dt>Workspace scan limit</dt><dd>{status.limits.workspaceScanLimit.toLocaleString()} entries</dd>
        <dt>Scheduling</dt><dd>One top-level request at a time; deterministic waves</dd>
      </dl></div></Card>
    </div>
    <Card title="Service and browser session"><div style={{ padding: '14px 16px' }}><dl class="kv">
      <dt>Listening</dt><dd class="mono">{status.service.host}:{status.service.port} · data {status.service.dataDir}</dd>
      <dt>Browser session</dt><dd>Signed in with a one-time link; ends after 12 h idle, 24 h in total, or when the service restarts. Sign out from the top bar.</dd>
      <dt>CLI access</dt><dd>Bearer token in <span class="mono">api-token</span>, never sent to the browser</dd>
      <dt>Version</dt><dd class="mono">devagents {status.service.version} · node {status.service.node} · {status.service.platform} · started {formatTime(status.service.startedAt)}</dd>
    </dl></div></Card>
  </>;
}
export function SignedOutPage() {
  return <div style={{ maxWidth: '560px', margin: '48px auto', padding: '0 16px' }}>
    <Card><div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <b style={{ fontSize: '20px' }}>Signed out</b>
      <span>Your browser session has ended. Sessions end on sign-out, after 12 hours idle, or when the service restarts.</span>
      <span>Create a new one-time link in the terminal and open it:</span>
      <Code>devagents ui</Code>
      <span class="muted" style={{ fontSize: '13px' }}>With npm: <code>npm run cli -- ui</code>. In Docker: <code>docker compose exec devagents node dist/cli/main.js ui</code>. The link is single use and expires in 10 minutes; the CLI token itself is never shown to the browser.</span>
    </div></Card>
  </div>;
}
