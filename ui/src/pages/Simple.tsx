import { useState } from 'preact/hooks';
import { api, ApiError, resources, type Project, type TeamSummary } from '../api';
import { Card, Chip, Code, Empty, ErrorNote, Later, Skeleton } from '../components/ui';
import { formatTime } from '../format';
import { usePoll } from '../state';

/** Sets or clears a project's default team under the project's version; a stale version reloads instead of overwriting. */
function DefaultTeam({ project, teams, onChanged }: { project: Project; teams: TeamSummary[] | undefined; onChanged: () => void }) {
  const [busy, setBusy] = useState(false); const [note, setNote] = useState<{ tone: 'warn' | 'bad'; text: string } | undefined>();
  const current = teams?.find(t => t.id === project.defaultTeamId);
  const choose = async (teamId: string | null) => {
    setBusy(true); setNote(undefined);
    try { await api(`/projects/${encodeURIComponent(project.id)}/default-team`, { method: 'PUT', body: { teamId, expectedVersion: project.version } }); onChanged(); }
    catch (e) { setNote(e instanceof ApiError && e.code === 'stale_project' ? { tone: 'warn', text: 'Project settings changed elsewhere; the current value is shown again. Choose once more if you still want it.' } : { tone: 'bad', text: e instanceof Error ? e.message : String(e) }); onChanged(); }
    finally { setBusy(false); }
  };
  const id = `default-team-${project.id}`;
  return <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 }}>
    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
      <label class="sr-only" for={id}>Default team for {project.id}</label>
      <select id={id} value={project.defaultTeamId ?? ''} disabled={busy || !teams} onChange={e => { const v = (e.target as HTMLSelectElement).value; void choose(v || null); }} style={{ minHeight: '34px', borderRadius: '8px', border: '1px solid var(--btn-border)', background: '#fff', font: 'inherit', padding: '0 10px', maxWidth: '100%' }}>
        <option value="">None · legacy agent configuration</option>
        {(teams ?? []).filter(t => !t.archived || t.id === project.defaultTeamId).map(t => <option key={t.id} value={t.id} disabled={t.archived}>{t.name} · revision {t.revision}{t.archived ? ' · archived' : t.readiness.ready ? '' : ' · draft'}</option>)}
      </select>
      {current ? current.archived ? <Chip tone="bad">✕ Archived · submissions fail until changed</Chip> : current.readiness.ready ? <Chip tone="ok">✓ Ready</Chip> : <Chip tone="warn">⚠ Draft · submissions fail until ready</Chip> : null}
      {project.defaultTeamId && !current && teams && <Chip tone="bad">Unknown team</Chip>}
    </div>
    <span class="muted" style={{ fontSize: '12px' }}>{current ? <>Applies to tasks submitted without an explicit team; each task freezes revision {current.revision} at submission. <a href={`/ui/teams/${current.id}`}>Open team</a></> : 'Tasks without an explicit team use the resolved YAML agents (legacy).'}</span>
    {note && <span class={`note ${note.tone}`} role="alert" style={{ fontSize: '12.5px' }}>{note.text}</span>}
  </div>;
}
export function ProjectsPage() {
  const projects = usePoll(resources.projects.key, resources.projects.load, resources.projects.intervalMs);
  const teams = usePoll(resources.teams.key, resources.teams.load, resources.teams.intervalMs);
  const status = usePoll(resources.status.key, resources.status.load, resources.status.intervalMs).data;
  const docker = status?.service.dataDir === '/data';
  return <>
    <div class="page-head"><div><div class="h">Projects</div><h1>Registered repositories</h1><p>Existing Git checkouts registered by absolute path. Work happens in managed worktrees; the original checkout is never modified.</p></div><a class="btn primary" href="/ui/projects/new">Register repository</a></div>
    {projects.error && !projects.data && <ErrorNote message={projects.error} />}
    {!projects.data ? <Skeleton rows={3} label="Loading projects" /> : projects.data.length === 0 ? <Card><Empty title="No projects yet"><span>Register an existing Git checkout by its absolute path. DevAgents never clones or imports.</span><Code>devagents projects add my-project /absolute/path</Code></Empty></Card> : <div class="items" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))' }}>{projects.data.map(p => <article key={p.id} class="card item" style={{ padding: '18px 20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}><b style={{ fontSize: '17px' }}>{p.id}</b><Chip tone="ok">✓ Registered Git root</Chip></div>
      <div class="mono wrap-anywhere">{p.path}</div>
      <dl class="kv" style={{ gridTemplateColumns: '150px minmax(0, 1fr)' }}>
        <dt>Registered</dt><dd>{formatTime(p.registeredAt)} · base <span class="mono">{p.baseSha.slice(0, 7)}</span></dd>
        <dt>Default mode</dt><dd>{p.defaultMode ?? <span class="muted">None · each task asks once</span>}</dd>
        <dt>Default team</dt><dd><DefaultTeam project={p} teams={teams.data} onChanged={() => { projects.reload(); teams.reload(); }} /></dd>
        <dt>Path check</dt><dd class="muted">Verified at registration; execution rechecks access.</dd>
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
    <div class="page-head"><div><div class="h">Settings</div><h1>Connection, engine and limits</h1><p>Service configuration is read-only here. Values come from the running service; edit <span class="mono">devagents.yaml</span> and restart, or use the terminal setup below.</p></div></div>
    <Card title="Codex connection" right={<span style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>{c.vaultLocked ? <Chip tone="warn">⚠ Credentials locked</Chip> : c.signedIn ? <Chip tone="ok">✓ Sign-in saved</Chip> : c.installed ? <Chip tone="warn">⚠ Not signed in</Chip> : <Chip tone="bad">✕ Not installed</Chip>}<Chip tone="warn">⚠ Model access not verified</Chip></span>}
      foot={<span style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}><a class="btn" href="/ui/settings/setup">Guided setup / change sign-in</a><Later label="Test connection" increment="U3" reason="Browser testing is unavailable; use the explicitly chosen terminal connection test" /><span>Terminal setup today: <Code>npm run cli -- auth setup</Code> or <Code>./devagents start</Code></span></span>}>
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
        <dt>Default model</dt><dd>{status.defaults.model ? <span class="mono">{status.defaults.model}</span> : 'runtime default (not pinned) · set defaultModel in devagents.yaml to pin team snapshots'}</dd>
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
      <a href="/ui/tasks/new">Recover an unresolved submission after signing in</a>
      <span>Your browser session has ended. Sessions end on sign-out, after 12 hours idle, or when the service restarts.</span>
      <span>Create a new one-time link in the terminal and open it:</span>
      <Code>devagents ui</Code>
      <span class="muted" style={{ fontSize: '13px' }}>With npm: <code>npm run cli -- ui</code>. In Docker: <code>docker compose exec devagents node dist/cli/main.js ui</code>. The link is single use and expires in 10 minutes; the CLI token itself is never shown to the browser.</span>
    </div></Card>
  </div>;
}
