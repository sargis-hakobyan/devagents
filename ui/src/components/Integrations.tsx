import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { api, SignedOutError, type ConnectionState, type GitHubConnection, type Integrations, type JiraConnection, type JiraMatches, type JiraRuleInput, type ProjectTool, type SavedToken, type ToolConnection, type ToolMatches, type ToolOptions } from '../api';
import { formatTime, type Tone } from '../format';
import { onSignedOut } from '../state';
import { Chip, Code, ErrorNote, Skeleton } from './ui';
import { Autocomplete, type Choice } from './Autocomplete';

type Kind = 'github' | 'jira' | 'tool';
const base = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/integrations`;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const days = (n: number) => n === 0 ? 'today' : n === 1 ? 'in 1 day' : `in ${n} days`;

export function stateChip(c: { state: ConnectionState; expiresInDays?: number }): { tone: Tone; text: string } {
  switch (c.state) {
    case 'connected': return { tone: 'ok', text: '✓ Connected' };
    case 'expiring': return { tone: 'warn', text: `⚠ Expires ${days(c.expiresInDays ?? 0)}` };
    case 'expired': return { tone: 'bad', text: '✕ Token expired' };
    case 'rejected': return { tone: 'bad', text: '✕ Token not accepted' };
    case 'unreachable': return { tone: 'warn', text: '⚠ Not reachable' };
    case 'locked': return { tone: 'neutral', text: 'Locked' };
  }
}
const needsToken = (state: ConnectionState) => ['expiring', 'expired', 'rejected'].includes(state);
export const Logo = ({ kind, small }: { kind: Kind; small?: boolean }) => <span class={`integ-logo ${kind}${small ? ' small' : ''}`} aria-hidden="true">
  <svg width={small ? 19 : 24} height={small ? 19 : 24} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    {kind === 'github' ? <><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="8" r="2.5" /><path d="M6 8.5v7M18 10.5c0 4-6 3-11.5 5.5" /></> : kind === 'jira' ? <><rect x="4" y="4" width="16" height="16" rx="3" /><path d="m8.5 12 2.5 2.5 4.5-5" /></> : <path d="M9 3v5M15 3v5M6 8h12v4a6 6 0 0 1-12 0zM12 18v3" />}
  </svg>
</span>;
const External = ({ href, children }: { href: string; children: ComponentChildren }) => <a href={href} target="_blank" rel="noopener noreferrer" style={{ fontSize: '13px', fontWeight: 700 }}>{children} ↗</a>;

function Tile({ kind, name, what, connection, line, foot, open, onOpen }: { kind: Kind; name: string; what: string; connection: { state: ConnectionState; expiresInDays?: number } | null; line: ComponentChildren; foot: ComponentChildren; open: boolean; onOpen: () => void }) {
  const chip = connection ? stateChip(connection) : undefined;
  const replace = connection && needsToken(connection.state);
  return <article class={`card integ-tile${connection ? '' : ' off'}${open ? ' open' : ''}`} aria-label={`${name}, ${connection ? chip!.text.replace(/^[✓✕⚠] /, '').toLowerCase() : 'not connected'}`}>
    <div class="integ-top"><Logo kind={kind} /><div style={{ minWidth: 0 }}><b class="integ-name">{name}</b><span class="integ-what">{what}</span></div></div>
    <div class="integ-state">{chip ? <><Chip tone={chip.tone}>{chip.text}</Chip><span class="wrap-anywhere">{line}</span></> : <span class="muted">Not connected</span>}</div>
    <div class="integ-foot"><span class="wrap-anywhere">{foot}</span><button type="button" class={`btn small${!connection || replace ? ' primary' : ''}`} aria-expanded={open} onClick={onOpen}>{!connection ? 'Connect' : replace ? 'Replace token' : 'Manage'}</button></div>
  </article>;
}

/** Runs one request at a time and keeps its failure next to the control that caused it. */
export function useAction() {
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const lock = useRef(false);
  const run = async (work: () => Promise<void>) => {
    if (lock.current) return; lock.current = true; setBusy(true); setError('');
    try { await work(); } catch (e) { if (e instanceof SignedOutError) onSignedOut(); else setError(message(e)); }
    finally { lock.current = false; setBusy(false); }
  };
  return { busy, error, run, clear: () => setError('') };
}
type Using = { id: string; name: string };
const others = (view: Integrations, kind: 'github' | 'jira'): Using[] => view.savedTokens[kind].find(t => t.id === view[kind]?.savedToken)?.usedBy.filter(p => p.id !== view.projectId) ?? [];
const names = (projects: Using[]) => projects.length === 1 ? `project ${projects[0]!.name}` : `projects ${projects.map(p => p.name).join(', ')}`;
/** Choose a token another project already saved, or paste a new one. Shown only when there is one to reuse. */
function SavedTokenChoice({ name, tokens, value, disabled, onChange }: { name: string; tokens: SavedToken[]; value: string; disabled: boolean; onChange: (id: string) => void }) {
  return <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
    <legend class="sr-only">Which token</legend>
    {tokens.map(t => <label key={t.id} class="integ-radio"><input type="radio" name={name} checked={value === t.id} disabled={disabled} onChange={() => onChange(t.id)} /><span><b>Use the token saved for {t.label}</b> <span class="muted">· used by {names(t.usedBy)}</span></span></label>)}
    <label class="integ-radio"><input type="radio" name={name} checked={value === ''} disabled={disabled} onChange={() => onChange('')} /><span>Use another token</span></label>
  </fieldset>;
}
function Disconnect({ name, busy, sharedWith, onConfirm }: { name: string; busy: boolean; sharedWith: Using[]; onConfirm: () => void }) {
  const [asking, setAsking] = useState(false);
  if (!asking) return <button type="button" class="btn small quiet" disabled={busy} onClick={() => setAsking(true)}>Disconnect</button>;
  return <span class="integ-actions" role="group" aria-label={`Disconnect ${name}?`}><span style={{ fontSize: '13px' }}>{sharedWith.length ? `Forget this connection? The token stays saved for ${names(sharedWith)}.` : 'Forget the token and this connection?'}</span><button type="button" class="btn small" disabled={busy} onClick={onConfirm}>Yes, disconnect {name}</button><button type="button" class="btn small quiet" disabled={busy} onClick={() => setAsking(false)}>Keep</button></span>;
}
function TokenSource({ view, variable, children }: { view: Integrations; variable: string | undefined; children: ComponentChildren }) {
  if (view.secrets.mode === 'vault') return <>{children}</>;
  return <div class="note info">This service has no encrypted vault, so a token cannot be pasted here. Set <Code>{variable ?? 'the token variable'}</Code> in the service's environment, restart it, then press the button below.</div>;
}
function Problem({ connection }: { connection: GitHubConnection | JiraConnection }) {
  if (connection.state === 'locked') return <div class="note warn" role="status">Credentials are locked after a restart. Run <Code>./devagents start</Code> to unlock them.</div>;
  if (connection.problem) return <div class="note bad" role="status">{connection.problem.message} <span class="muted">Checked {formatTime(connection.problem.at)}.</span></div>;
  if (connection.state === 'expired') return <div class="note bad" role="status">This token has passed its end date. Create a new one and replace it here.</div>;
  if (connection.state === 'expiring') return <div class="note warn" role="status">This token ends {days(connection.expiresInDays ?? 0)}. Create a new one and replace it here; nothing else changes.</div>;
  return null;
}

function GitHubPanel({ projectId, view, onChange }: { projectId: string; view: Integrations; onChange: (next: Integrations) => void }) {
  const connection = view.github; const action = useAction();
  const [token, setToken] = useState(''); const [repository, setRepository] = useState(''); const [replacing, setReplacing] = useState(false);
  const vault = view.secrets.mode === 'vault'; const detected = view.folder.repository;
  const reusable = view.savedTokens.github.filter(t => t.id !== connection?.savedToken); const sharedWith = others(view, 'github');
  const [saved, setSaved] = useState(reusable[0]?.id ?? '');
  const form = !connection || replacing;
  const connect = (event: Event) => {
    event.preventDefault();
    void action.run(async () => {
      onChange(await api<Integrations>(`${base(projectId)}/github`, { method: 'PUT', body: { ...(saved ? { savedToken: saved } : vault && token ? { token } : {}), ...(!detected && repository ? { repository } : {}) } }));
      setToken(''); setReplacing(false);
    });
  };
  return <section class="card integ-panel" aria-label="GitHub connection">
    <div class="integ-panel-head"><div class="integ-title"><Logo kind="github" small />{connection ? 'GitHub' : 'Connect GitHub'}</div>
      <div class="integ-steps" aria-hidden="true"><span class={form ? 'on' : ''}><i>1</i>Token</span><span>—</span><span class={form ? '' : 'on'}><i>2</i>Folder</span></div></div>
    {connection && <Problem connection={connection} />}
    <div class="integ-cols">
      <div class="integ-col">
        <div class="h">1 · Your GitHub token</div>
        {form ? <form class="integ-col" onSubmit={connect}>
          {reusable.length > 0 && <SavedTokenChoice name="integ-github-saved" tokens={reusable} value={saved} disabled={action.busy} onChange={setSaved} />}
          {!saved && <TokenSource view={view} variable={view.secrets.githubVariable}>
            <label class="field">GitHub token<input type="password" autocomplete="off" spellcheck={false} required value={token} disabled={action.busy || view.secrets.locked} placeholder="github_pat_…  or  ghp_…" onInput={e => setToken((e.target as HTMLInputElement).value.trim())} /></label>
            <span class="hint">Starts with <span class="mono">github_pat_</span> (fine-grained, recommended) or <span class="mono">ghp_</span> (classic). It is checked with GitHub, stored encrypted and never shown again.{replacing && sharedWith.length ? ` Replacing it also replaces it for ${names(sharedWith)}.` : ''}</span>
          </TokenSource>}
          <div class="integ-actions"><button type="submit" class="btn primary" disabled={action.busy || view.secrets.locked}>{action.busy ? 'Checking with GitHub…' : connection ? 'Replace token' : 'Connect'}</button>
            {replacing && <button type="button" class="btn quiet" disabled={action.busy} onClick={() => { setReplacing(false); setToken(''); action.clear(); }}>Cancel</button>}
            {!saved && <External href="https://github.com/settings/personal-access-tokens/new">Create a token on GitHub</External>}</div>
        </form> : <div class="integ-summary">
          <span>Signed in as <b>@{connection.login}</b> · {connection.tokenKind === 'fine-grained' ? 'fine-grained token' : 'classic token'}</span>
          <span>{connection.canPush === true ? 'Can push branches to this repository.' : connection.canPush === false ? 'Read only: this token cannot push to this repository.' : 'GitHub does not report whether this token can push.'}</span>
          <span class="muted">{connection.expiresAt ? `Token valid until ${day(connection.expiresAt)}` : 'GitHub reports no end date for this token'} · checked {formatTime(connection.checkedAt)}</span>
          {sharedWith.length > 0 && <span class="muted">One token, also used by {names(sharedWith)}.</span>}
          <div class="integ-actions"><button type="button" class={`btn small${needsToken(connection.state) ? ' primary' : ''}`} disabled={action.busy} onClick={() => { setReplacing(true); setSaved(''); }}>Replace token</button>
            <button type="button" class="btn small" disabled={action.busy || view.secrets.locked} onClick={() => void action.run(async () => onChange(await api<Integrations>(`${base(projectId)}/github/check`, { method: 'POST', body: {} })))}>{action.busy ? 'Checking…' : 'Check again'}</button>
            <Disconnect name="GitHub" busy={action.busy} sharedWith={sharedWith} onConfirm={() => void action.run(async () => onChange(await api<Integrations>(`${base(projectId)}/github`, { method: 'DELETE' })))} /></div>
        </div>}
        {action.error && <div class="note bad" role="alert">{action.error}</div>}
      </div>
      <div class="integ-col">
        <div class="h">2 · The folder on this computer</div>
        <div class="field">Local folder<div class="integ-ro"><span class="mono wrap-anywhere">{view.folder.hostPath ?? view.folder.path}</span><Chip tone="ok">✓ already cloned</Chip></div></div>
        {connection && !replacing ? <div class="field">Repository<div class="integ-ro"><span class="mono wrap-anywhere">{connection.repository}</span>{detected && detected !== connection.repository && <span class="hint">the folder now points to {detected}</span>}</div></div>
          : detected ? <div class="field">Repository<div class="integ-ro"><span class="mono wrap-anywhere">{detected}</span><span class="hint">read from the folder</span></div></div>
          : <><label class="field">Repository<input type="text" spellcheck={false} value={repository} disabled={action.busy} placeholder="owner/name" onInput={e => setRepository((e.target as HTMLInputElement).value.trim())} /></label><span class="hint">This folder has no GitHub remote named <span class="mono">origin</span>, so enter the repository it belongs to.</span></>}
        <span class="hint">Nothing is cloned or moved. DevAgents works in the folder you already have.</span>
      </div>
    </div>
  </section>;
}

type Preview = { state: 'idle' } | { state: 'loading' } | { state: 'ok'; value: JiraMatches } | { state: 'bad'; text: string };
/** What the rule matches in Jira right now, so a wrong rule is visible before it is saved. */
function MatchLine({ filtered, preview, approximate }: { filtered: boolean; preview: Preview; approximate: boolean }) {
  const found = preview.state === 'ok' ? preview.value : undefined;
  const more = found ? (found.count ?? 0) > found.keys.length : false;
  return <div class={`integ-match${found?.keys.length ? ' ok' : preview.state === 'bad' ? ' bad' : ''}`} role="status" aria-live="polite">
    {!filtered ? <span>Choose a column, an assignee or a label. A rule never means every ticket in the project.</span>
      : preview.state === 'bad' ? <span>{preview.text}</span>
      : !found ? <span>Asking Jira what this matches…</span>
      : found.keys.length === 0 ? <span><b>No tickets match right now.</b> The rule can still be saved.</span>
      : <><span aria-hidden="true">✓</span><span><b>{found.count === null ? 'Matches tickets now:' : `Matches ${approximate && more ? 'about ' : ''}${found.count} ticket${found.count === 1 ? '' : 's'} now:`}</b> {found.keys.join(', ')}{more ? ', …' : ''}</span></>}
  </div>;
}

type Columns = { columns: { name: string; statusIds: string[] }[]; columnsFrom: 'board' | 'statuses' };
function JiraRuleEditor({ projectId, jira, onChange }: { projectId: string; jira: JiraConnection; onChange: (next: Integrations) => void }) {
  const saved = jira.rule; const action = useAction();
  const [project, setProject] = useState<Choice | undefined>(saved ? { id: saved.project.key, name: saved.project.name } : undefined);
  const [column, setColumn] = useState(saved?.column?.name ?? ''); const [assignee, setAssignee] = useState<Choice | undefined>(saved?.assignee); const [label, setLabel] = useState(saved?.label ?? '');
  const [start, setStart] = useState<'manual' | 'auto'>(saved?.start ?? 'manual');
  const [columns, setColumns] = useState<Columns>(); const [loadError, setLoadError] = useState('');
  const [matches, setMatches] = useState<Preview>({ state: 'idle' });
  const [note, setNote] = useState(''); const sequence = useRef(0);
  const usable = !['rejected', 'expired', 'locked', 'unreachable'].includes(jira.state);
  const key = project?.id ?? '';

  // Projects, people and labels are looked up in Jira as you type; a large Jira has far more than a list can hold.
  const suggest = (kind: 'projects' | 'people' | 'labels') => async (query: string): Promise<Choice[]> => {
    const params = new URLSearchParams({ kind, query, ...(kind === 'people' ? { project: key } : {}) });
    try { return (await api<{ items: Choice[] }>(`${base(projectId)}/jira/suggest?${params}`)).items; }
    catch (e) { if (e instanceof SignedOutError) onSignedOut(); throw e; }
  };
  // The columns of the chosen project are few, so they stay a plain list.
  useEffect(() => {
    if (!usable || !key) { setColumns(undefined); return; }
    let current = true; setLoadError(''); setColumns(undefined);
    api<{ options: Columns }>(`${base(projectId)}/jira/columns?project=${encodeURIComponent(key)}`).then(
      next => { if (current) setColumns(next.options); },
      e => { if (!current) return; if (e instanceof SignedOutError) onSignedOut(); else setLoadError(message(e)); });
    return () => { current = false; };
  }, [projectId, key, usable, jira.site, jira.checkedAt]);

  const rule: JiraRuleInput = { project: key, start, ...(column ? { column } : {}), ...(assignee ? { assignee: assignee.id } : {}), ...(label.trim() ? { label: label.trim() } : {}) };
  useEffect(() => {
    const id = ++sequence.current;
    if (!usable || !key) { setMatches({ state: 'idle' }); return; }
    setMatches({ state: 'loading' });
    const timer = setTimeout(() => {
      api<{ matches: JiraMatches }>(`${base(projectId)}/jira/preview`, { method: 'POST', body: rule }).then(
        result => { if (id === sequence.current) setMatches({ state: 'ok', value: result.matches }); },
        e => { if (id !== sequence.current) return; if (e instanceof SignedOutError) onSignedOut(); else setMatches({ state: 'bad', text: message(e) }); });
    }, 400);
    return () => clearTimeout(timer);
  }, [projectId, key, column, assignee?.id, label, usable]);

  const changeProject = (next: Choice | undefined) => { setProject(next); setColumn(''); setAssignee(undefined); setLabel(''); setNote(''); };
  // Without a saved rule, an empty form has nothing to save; with one, clearing the project is a change like any other.
  const unchanged = saved ? saved.project.key === key && (saved.column?.name ?? '') === column && (saved.assignee?.id ?? '') === (assignee?.id ?? '') && (saved.label ?? '') === label.trim() && saved.start === start : !key;
  const save = (event: Event) => {
    event.preventDefault(); setNote('');
    void action.run(async () => {
      // No project means no rule: saving that removes the saved one, and no tickets come from Jira.
      if (!key) { onChange(await api<Integrations>(`${base(projectId)}/jira/rule`, { method: 'DELETE' })); setStart('manual'); setNote('Saved. No tickets come from Jira.'); return; }
      onChange((await api<{ integrations: Integrations }>(`${base(projectId)}/jira/rule`, { method: 'PUT', body: rule })).integrations); setNote('Rule saved.');
    });
  };
  if (!usable) return <div class="integ-col"><div class="h">2 · Which tickets</div><span class="muted" style={{ fontSize: '13.5px' }}>Tickets can be chosen again once the token works.{saved ? ` The saved rule for ${saved.project.key} is kept.` : ''}</span></div>;
  const kind = columns?.columnsFrom === 'statuses' ? 'status' : 'column';
  return <form class="integ-col" onSubmit={save} aria-label="Which tickets">
    <div class="h">2 · Which tickets</div>
    <div class="field"><label for="integ-rule-project">Pick up tickets from project</label>
      <Autocomplete id="integ-rule-project" what="project" value={project} onChange={changeProject} search={suggest('projects')} placeholder="Type a project name or key" disabled={action.busy} describe={c => `${c.id} · ${c.name}`} /></div>
    {!project ? <span class="muted" style={{ fontSize: '13.5px' }}>No project chosen: no tickets come from Jira. Choose a project to pick up its tickets; column, assignee and label are optional.</span> : <>
      {loadError && <div class="note bad" role="alert">{loadError}</div>}
      <div class="integ-rule" role="group" aria-label="Filters, all optional">
        <label for="integ-rule-column">in {kind}</label>
        <select id="integ-rule-column" value={column} disabled={action.busy || !columns} onChange={e => { setColumn((e.target as HTMLSelectElement).value); setNote(''); }}><option value="">{columns ? `any ${kind}` : loadError ? 'not available' : 'loading…'}</option>{[...new Set([...(column ? [column] : []), ...(columns?.columns.map(c => c.name) ?? [])])].map(name => <option key={name} value={name}>{name}</option>)}</select>
        <label for="integ-rule-assignee">assigned to</label>
        <Autocomplete id="integ-rule-assignee" what="assignee" value={assignee} onChange={next => { setAssignee(next); setNote(''); }} search={suggest('people')} placeholder="anyone" disabled={action.busy} />
        <label for="integ-rule-label">with label</label>
        <Autocomplete id="integ-rule-label" what="label" free value={label ? { id: label, name: label } : undefined} onChange={next => { setLabel(next?.id ?? ''); setNote(''); }} search={suggest('labels')} placeholder="any label" disabled={action.busy} />
      </div>
      <MatchLine filtered preview={matches} approximate={jira.kind === 'cloud'} />
      <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <legend style={{ fontSize: '13px', fontWeight: 700, padding: 0, marginBottom: '6px' }}>When a ticket matches</legend>
        <label class="integ-radio"><input type="radio" name="integ-rule-start" checked={start === 'manual'} disabled={action.busy} onChange={() => { setStart('manual'); setNote(''); }} /><span><b>Wait until someone starts it</b> <span class="muted">· recommended</span></span></label>
        <label class="integ-radio"><input type="radio" name="integ-rule-start" checked={start === 'auto'} disabled={action.busy} onChange={() => { setStart('auto'); setNote(''); }} /><span>Start on its own</span></label>
      </fieldset>
    </>}
    <div class="integ-actions"><button type="submit" class="btn primary" disabled={action.busy || unchanged}>{action.busy ? 'Saving…' : 'Save rule'}</button>
      <span class="muted" style={{ fontSize: '13px' }} role="status">{note || (saved && unchanged ? `Saved ${formatTime(saved.savedAt)}` : '')}</span></div>
    {action.error && <div class="note bad" role="alert">{action.error}</div>}
  </form>;
}

function JiraPanel({ projectId, view, onChange }: { projectId: string; view: Integrations; onChange: (next: Integrations) => void }) {
  const connection = view.jira; const action = useAction(); const vault = view.secrets.mode === 'vault';
  const [kind, setKind] = useState<'cloud' | 'data-center'>(connection?.kind ?? 'cloud');
  const [site, setSite] = useState(connection?.site.replace(/^https:\/\//, '') ?? ''); const [email, setEmail] = useState(connection?.email ?? '');
  const [token, setToken] = useState(''); const [expiresOn, setExpiresOn] = useState(''); const [replacing, setReplacing] = useState(false);
  const form = !connection || replacing; const cloud = kind === 'cloud';
  const reusable = view.savedTokens.jira.filter(t => t.id !== connection?.savedToken); const sharedWith = others(view, 'jira');
  const [saved, setSaved] = useState(reusable[0]?.id ?? '');
  const connect = (event: Event) => {
    event.preventDefault();
    void action.run(async () => {
      onChange(await api<Integrations>(`${base(projectId)}/jira`, { method: 'PUT', body: saved ? { savedToken: saved } : { kind, site, ...(cloud ? { email } : {}), ...(vault && token ? { token } : {}), ...(expiresOn ? { expiresOn } : {}) } }));
      setToken(''); setExpiresOn(''); setReplacing(false);
    });
  };
  return <section class="card integ-panel" aria-label="Jira connection">
    <div class="integ-panel-head"><div class="integ-title"><Logo kind="jira" small />{connection ? 'Jira' : 'Connect Jira'}</div>
      <div class="integ-steps" aria-hidden="true"><span class={form ? 'on' : ''}><i>1</i>Token</span><span>—</span><span class={form ? '' : 'on'}><i>2</i>Tickets</span></div></div>
    {connection && <Problem connection={connection} />}
    <div class="integ-cols">
      <div class="integ-col">
        <div class="h">1 · Your Jira token</div>
        {form ? <form class="integ-col" onSubmit={connect}>
          {reusable.length > 0 && <SavedTokenChoice name="integ-jira-saved" tokens={reusable} value={saved} disabled={action.busy} onChange={setSaved} />}
          {saved ? <span class="hint">The Jira site and account come with the saved token. Which tickets to pick up is still chosen for this project.</span> : <>
          <div class="integ-seg" role="radiogroup" aria-label="Kind of Jira">
            <label><input type="radio" name="integ-jira-kind" checked={cloud} disabled={action.busy} onChange={() => setKind('cloud')} />Jira Cloud</label>
            <label><input type="radio" name="integ-jira-kind" checked={!cloud} disabled={action.busy} onChange={() => setKind('data-center')} />Self-hosted</label>
          </div>
          <label class="field">{cloud ? 'Jira site' : 'Jira address'}<input type="text" spellcheck={false} required value={site} disabled={action.busy} placeholder={cloud ? 'example.atlassian.net' : 'https://jira.example.com'} onInput={e => setSite((e.target as HTMLInputElement).value.trim())} /></label>
          {cloud && <label class="field">Email of the Atlassian account<input type="email" spellcheck={false} required value={email} disabled={action.busy} placeholder="devagents@example.com" onInput={e => setEmail((e.target as HTMLInputElement).value.trim())} /></label>}
          <TokenSource view={view} variable={view.secrets.jiraVariable}>
            <label class="field">{cloud ? 'API token' : 'Personal access token'}<input type="password" autocomplete="off" spellcheck={false} required value={token} disabled={action.busy || view.secrets.locked} placeholder={cloud ? 'ATATT…' : 'Paste the token here'} onInput={e => setToken((e.target as HTMLInputElement).value.trim())} /></label>
          </TokenSource>
          <span class="hint">{cloud ? 'A Jira token does not say whose it is, so it only works together with the email. For a team, use a shared or service account: tickets are read as that account.' : 'No email here: this token already knows who you are.'}</span>
          <label class="field">Token end date (optional)<input type="date" value={expiresOn} disabled={action.busy} onInput={e => setExpiresOn((e.target as HTMLInputElement).value)} /></label>
          <span class="hint">{cloud ? 'Atlassian ends every token after a year at most and shows the date when you create it.' : 'Jira shows the date when you create the token.'} Jira does not report it later, so enter it here to be reminded before it ends.{replacing && sharedWith.length ? ` Replacing the token also replaces it for ${names(sharedWith)}.` : ''}</span>
          </>}
          <div class="integ-actions"><button type="submit" class="btn primary" disabled={action.busy || view.secrets.locked}>{action.busy ? 'Checking with Jira…' : connection ? 'Replace token' : 'Connect'}</button>
            {replacing && <button type="button" class="btn quiet" disabled={action.busy} onClick={() => { setReplacing(false); setToken(''); action.clear(); }}>Cancel</button>}
            {cloud && !saved && <External href="https://id.atlassian.com/manage-profile/security/api-tokens">Create a token at Atlassian</External>}</div>
        </form> : <div class="integ-summary">
          <span><b>{connection.site.replace(/^https:\/\//, '')}</b> · {connection.kind === 'cloud' ? 'Jira Cloud' : 'self-hosted Jira'}</span>
          <span>Acts as <b>{connection.account}</b>{connection.email ? ` (${connection.email})` : ''}{connection.gateway ? ' · token with scopes' : ''}</span>
          <span class="muted">{connection.expiresOn ? `Token valid until ${day(`${connection.expiresOn}T00:00:00Z`)}` : 'No end date recorded for this token'} · checked {formatTime(connection.checkedAt)}</span>
          {sharedWith.length > 0 && <span class="muted">One token, also used by {names(sharedWith)}.</span>}
          <div class="integ-actions"><button type="button" class={`btn small${needsToken(connection.state) ? ' primary' : ''}`} disabled={action.busy} onClick={() => { setReplacing(true); setSaved(''); }}>Replace token</button>
            <button type="button" class="btn small" disabled={action.busy || view.secrets.locked} onClick={() => void action.run(async () => onChange(await api<Integrations>(`${base(projectId)}/jira/check`, { method: 'POST', body: {} })))}>{action.busy ? 'Checking…' : 'Check again'}</button>
            <Disconnect name="Jira" busy={action.busy} sharedWith={sharedWith} onConfirm={() => void action.run(async () => onChange(await api<Integrations>(`${base(projectId)}/jira`, { method: 'DELETE' })))} /></div>
        </div>}
        {action.error && <div class="note bad" role="alert">{action.error}</div>}
      </div>
      {connection ? <JiraRuleEditor key={`${connection.site}:${connection.connectedAt}`} projectId={projectId} jira={connection} onChange={onChange} />
        : <div class="integ-col"><div class="h">2 · Which tickets</div><span class="muted" style={{ fontSize: '13.5px' }}>After connecting you choose a Jira project and which of its tickets may become tasks: by board column, assignee or label.</span></div>}
    </div>
    {form && !saved && <div>
      <div class="h" style={{ marginBottom: '8px' }}>Where do I get the token?</div>
      {cloud ? <><div class="integ-how">
        <div><i>1</i><span>Open <span class="mono">id.atlassian.com</span>, then <b>Security → API tokens</b>.</span></div>
        <div><i>2</i><span><b>Create API token</b>, name it "DevAgents" and choose when it expires. One year is the longest.</span></div>
        <div><i>3</i><span>Copy it and paste it here. Atlassian shows it only once.</span></div>
      </div><p class="hint" style={{ margin: '8px 0 0' }}>If you create a token "with scopes", choose the app <b>Jira</b> and the scopes <span class="mono">read:jira-work</span> and <span class="mono">read:jira-user</span>, and <span class="mono">write:jira-work</span> so a started ticket can be assigned to you. The plain token needs no choices.</p></>
        : <div class="integ-how" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}><div><i>1</i><span>In Jira, open your <b>Profile → Personal access tokens</b>, create a token named "DevAgents" and paste it here.</span></div></div>}
    </div>}
  </section>;
}

/** Several values for one part of a rule: the chosen ones as removable chips, and a field that adds another. */
function MultiPick({ id, what, values, onChange, choices, placeholder, free, disabled }: { id: string; what: string; values: Choice[]; onChange: (next: Choice[]) => void; choices: Choice[]; placeholder: string; free?: boolean; disabled: boolean }) {
  const left = choices.filter(c => !values.some(v => v.id === c.id));
  const search = async (query: string) => left.filter(c => `${c.name} ${c.id}`.toLowerCase().includes(query.toLowerCase())).slice(0, 20);
  return <div class="integ-multi">
    {values.length > 0 && <span class="integ-chips">{values.map(v => <span key={v.id} class="integ-pick">{v.name}<button type="button" aria-label={`Remove ${what} ${v.name}`} disabled={disabled} onClick={() => onChange(values.filter(x => x.id !== v.id))}>×</button></span>)}</span>}
    {/* The field is recreated after each choice, so it is empty again and ready for the next one. */}
    <Autocomplete key={values.map(v => v.id).join('|')} id={id} what={what} value={undefined} onChange={next => { if (next && !values.some(v => v.id === next.id)) onChange([...values, next]); }} search={search} placeholder={values.length ? `add another ${what}` : placeholder} disabled={disabled} {...(free ? { free: true } : {})} />
  </div>;
}
const sameIds = (a: { id: string }[] | undefined, b: { id: string }[]) => (a ?? []).map(x => x.id).join('|') === b.map(x => x.id).join('|');
const named = (values: string[] | undefined): Choice[] => (values ?? []).map(v => ({ id: v, name: v }));

/** Tickets of an added tool that may become tasks. Every filter is optional and takes several values; the tool offers only the filters its mapping can answer. */
function ToolRuleEditor({ projectId, connection, onChange }: { projectId: string; connection: ToolConnection; onChange: (next: ProjectTool) => void }) {
  const saved = connection.rule; const action = useAction(); const name = connection.tracker.name; const path = `${base(projectId)}/trackers/${connection.trackerId}`;
  const [projects, setProjects] = useState<Choice[]>(saved?.projects ?? []); const [columns, setColumns] = useState<Choice[]>(named(saved?.columns));
  const [assignees, setAssignees] = useState<Choice[]>(saved?.assignees ?? []); const [labels, setLabels] = useState<Choice[]>(named(saved?.labels));
  const [start, setStart] = useState<'manual' | 'auto'>(saved?.start ?? 'manual');
  const [options, setOptions] = useState<ToolOptions>(); const [loadError, setLoadError] = useState('');
  const [found, setFound] = useState<{ state: 'loading' } | { state: 'ok'; value: ToolMatches } | { state: 'bad'; text: string }>({ state: 'loading' });
  const [note, setNote] = useState(''); const sequence = useRef(0);
  const usable = connection.tracker.state === 'connected';
  useEffect(() => {
    if (!usable) return;
    let current = true; setLoadError('');
    api<ToolOptions>(`${path}/options`).then(next => { if (current) setOptions(next); }, e => { if (!current) return; if (e instanceof SignedOutError) onSignedOut(); else setLoadError(message(e)); });
    return () => { current = false; };
  }, [projectId, usable, connection.trackerId, connection.tracker.checkedAt]);
  const ids = (values: Choice[]) => values.map(v => v.id);
  const rule = { start, projects: ids(projects), columns: ids(columns), assignees: ids(assignees), labels: ids(labels) };
  const signature = JSON.stringify([rule.projects, rule.columns, rule.assignees, rule.labels]);
  useEffect(() => {
    const id = ++sequence.current;
    if (!usable) return;
    setFound({ state: 'loading' });
    const timer = setTimeout(() => {
      api<{ matches: ToolMatches }>(`${path}/preview`, { method: 'POST', body: rule }).then(
        result => { if (id === sequence.current) setFound({ state: 'ok', value: result.matches }); },
        e => { if (id !== sequence.current) return; if (e instanceof SignedOutError) onSignedOut(); else setFound({ state: 'bad', text: message(e) }); });
    }, 400);
    return () => clearTimeout(timer);
  }, [projectId, signature, usable]);
  const unchanged = Boolean(saved) && sameIds(saved!.projects, projects) && sameIds(named(saved!.columns), columns) && sameIds(saved!.assignees, assignees) && sameIds(named(saved!.labels), labels) && saved!.start === start;
  const change = <T,>(set: (next: T) => void) => (next: T) => { set(next); setNote(''); };
  const save = (event: Event) => {
    event.preventDefault(); setNote('');
    void action.run(async () => { onChange(await api<ProjectTool>(`${path}/rule`, { method: 'PUT', body: rule })); setNote('Rule saved.'); });
  };
  if (!usable) return <div class="integ-col"><div class="h">2 · Which tickets</div><span class="muted" style={{ fontSize: '13.5px' }}>Tickets can be chosen again once {name} is reachable with a working token.{saved ? ' The saved rule is kept.' : ''}</span></div>;
  if (!options) return <div class="integ-col"><div class="h">2 · Which tickets</div>{loadError ? <div class="note bad" role="alert">{loadError}</div> : <Skeleton rows={3} label={`Asking ${name} what a rule can name`} />}</div>;
  const can = (part: ToolOptions['filters'][number]) => options.filters.includes(part);
  const matched = found.state === 'ok' ? found.value : undefined; const filtered = Boolean(projects.length || columns.length || assignees.length || labels.length);
  return <form class="integ-col" onSubmit={save} aria-label="Which tickets">
    <div class="h">2 · Which tickets</div>
    <div class="integ-rule" role="group" aria-label="Filters, all optional">
      {can('project') && <><label for="integ-tool-project">from projects</label>
        <MultiPick id="integ-tool-project" what="project" values={projects} onChange={change(setProjects)} choices={options.projects} placeholder="any project" disabled={action.busy} /></>}
      {can('column') && <><label for="integ-tool-column">in columns</label>
        <MultiPick id="integ-tool-column" what="column" values={columns} onChange={change(setColumns)} choices={named(options.columns)} placeholder="any column" disabled={action.busy} /></>}
      {can('assignee') && <><label for="integ-tool-assignee">assigned to</label>
        <MultiPick id="integ-tool-assignee" what="assignee" values={assignees} onChange={change(setAssignees)} choices={options.people} placeholder="anyone" disabled={action.busy} /></>}
      {can('label') && <><label for="integ-tool-label">with labels</label>
        <MultiPick id="integ-tool-label" what="label" free values={labels} onChange={change(setLabels)} choices={named(options.labels)} placeholder="any label" disabled={action.busy} /></>}
    </div>
    <div class={`integ-match${matched?.total ? ' ok' : found.state === 'bad' ? ' bad' : ''}`} role="status" aria-live="polite">
      {found.state === 'bad' ? <span>{found.text}</span>
        : !matched ? <span>Asking {name} what this matches…</span>
        : matched.total === 0 ? <span><b>No tickets match right now.</b> The rule can still be saved.</span>
        : <><span aria-hidden="true">✓</span><span><b>{filtered ? 'Matches' : 'No filter: all'} {matched.total} ticket{matched.total === 1 ? '' : 's'} now:</b> {matched.sample.map(t => t.key).join(', ')}{matched.total > matched.sample.length ? ', …' : ''}</span></>}
    </div>
    <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <legend style={{ fontSize: '13px', fontWeight: 700, padding: 0, marginBottom: '6px' }}>When a ticket matches</legend>
      <label class="integ-radio"><input type="radio" name="integ-tool-start" checked={start === 'manual'} disabled={action.busy} onChange={() => { setStart('manual'); setNote(''); }} /><span><b>Wait until someone starts it</b> <span class="muted">· recommended</span></span></label>
      <label class="integ-radio"><input type="radio" name="integ-tool-start" checked={start === 'auto'} disabled={action.busy} onChange={() => { setStart('auto'); setNote(''); }} /><span>Start on its own</span></label>
    </fieldset>
    <div class="integ-actions"><button type="submit" class="btn primary" disabled={action.busy || unchanged}>{action.busy ? 'Saving…' : 'Save rule'}</button>
      {saved && <button type="button" class="btn small quiet" disabled={action.busy} onClick={() => { setNote(''); void action.run(async () => { onChange(await api<ProjectTool>(`${path}/rule`, { method: 'DELETE' })); setProjects([]); setColumns([]); setAssignees([]); setLabels([]); setStart('manual'); setNote(`Rule removed. No tickets come from ${name} until you save a rule.`); }); }}>Remove rule</button>}
      <span class="muted" style={{ fontSize: '13px' }} role="status">{note || (unchanged ? `Saved ${formatTime(saved!.savedAt)}` : !saved ? `No rule saved: no tickets come from ${name} yet.` : '')}</span></div>
    {action.error && <div class="note bad" role="alert">{action.error}</div>}
  </form>;
}

/** One connected tool, or (without a connection) the choice of an added tool to connect. */
function ToolPanel({ projectId, view, connection, onChange, onConnected }: { projectId: string; view: ProjectTool; connection: ToolConnection | undefined; onChange: (next: ProjectTool) => void; onConnected: (trackerId: string) => void }) {
  const action = useAction(); const taken = new Set(view.connections.map(c => c.trackerId));
  const ready = view.trackers.filter(t => t.mapped && !taken.has(t.id)); const unmapped = view.trackers.filter(t => !t.mapped);
  const [chosen, setChosen] = useState(ready[0]?.id ?? ''); const [asking, setAsking] = useState(false);
  const connect = (event: Event) => { event.preventDefault(); void action.run(async () => { onChange(await api<ProjectTool>(`${base(projectId)}/trackers/${chosen}`, { method: 'PUT', body: {} })); onConnected(chosen); }); };
  const tool = connection?.tracker;
  return <section class="card integ-panel" aria-label={connection ? `${connection.tracker.name} connection` : 'Ticket tool connection'}>
    <div class="integ-panel-head"><div class="integ-title"><Logo kind="tool" small />{tool ? tool.name : 'Connect a ticket tool'}</div>
      <div class="integ-steps" aria-hidden="true"><span class={connection ? '' : 'on'}><i>1</i>Tool</span><span>—</span><span class={connection ? 'on' : ''}><i>2</i>Tickets</span></div></div>
    {tool?.state === 'locked' && <div class="note warn" role="status">Credentials are locked after a restart. Run <Code>./devagents start</Code> to unlock them.</div>}
    {tool?.problem && <div class="note bad" role="status">{tool.problem.message} <span class="muted">Checked {formatTime(tool.problem.at)}.</span> <a href="/ui/tools">Fix it on the Tools page</a></div>}
    <div class="integ-cols">
      <div class="integ-col">
        <div class="h">1 · Which tool</div>
        {tool ? <div class="integ-summary">
          <span><b>{tool.name}</b> · <span class="mono wrap-anywhere">{tool.url.replace(/^https:\/\//, '')}</span></span>
          {tool.account && <span>Acts as <b>{tool.account}</b></span>}
          <span class="muted">One token for this tool, saved once and used by every project that connects it · checked {formatTime(tool.checkedAt)}</span>
          <div class="integ-actions"><a class="btn small" href="/ui/tools">Manage tool</a>
            {asking ? <span class="integ-actions" role="group" aria-label={`Disconnect ${tool.name}?`}><span style={{ fontSize: '13px' }}>Stop using {tool.name} for this project? The tool and its token stay.</span><button type="button" class="btn small" disabled={action.busy} onClick={() => void action.run(async () => { onChange(await api<ProjectTool>(`${base(projectId)}/trackers/${tool.id}`, { method: 'DELETE' })); setAsking(false); })}>Yes, disconnect {tool.name}</button><button type="button" class="btn small quiet" disabled={action.busy} onClick={() => setAsking(false)}>Keep</button></span>
              : <button type="button" class="btn small quiet" disabled={action.busy} onClick={() => setAsking(true)}>Disconnect</button>}</div>
        </div> : ready.length ? <form class="integ-col" onSubmit={connect}>
          <label class="field">Ticket tool<select value={chosen} disabled={action.busy} onChange={e => setChosen((e.target as HTMLSelectElement).value)}>{ready.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
          <span class="hint">The tool's address and token were saved when it was added, so nothing is entered again. Which tickets to pick up is chosen for this project.</span>
          <div class="integ-actions"><button type="submit" class="btn primary" disabled={action.busy || !chosen}>{action.busy ? 'Connecting…' : 'Connect'}</button><a href="/ui/tools" style={{ fontSize: '13px', fontWeight: 700 }}>Add another tool →</a></div>
        </form> : <div class="integ-col">
          <span style={{ fontSize: '13.5px' }}>{unmapped.length ? `${unmapped.map(t => t.name).join(', ')} still ${unmapped.length === 1 ? 'needs' : 'need'} a mapping before a project can use it.` : view.trackers.length ? 'This project already uses every added tool. Add another tool to connect it here.' : 'No ticket tool is added yet. Any Jira-like tool with an MCP server can be added once and then used by every project.'}</span>
          <div class="integ-actions"><a class="btn primary" href="/ui/tools">{unmapped.length ? 'Finish on the Tools page' : 'Add a tool'}</a></div>
        </div>}
        {action.error && <div class="note bad" role="alert">{action.error}</div>}
      </div>
      {connection ? <ToolRuleEditor key={`${connection.trackerId}:${connection.connectedAt}`} projectId={projectId} connection={connection} onChange={onChange} />
        : <div class="integ-col"><div class="h">2 · Which tickets</div><span class="muted" style={{ fontSize: '13.5px' }}>After connecting you choose which of the tool's tickets may become tasks: by project, board column, assignee or label, as far as the tool supports them.</span></div>}
    </div>
  </section>;
}

/** Design: design/ui/U8-Integrations.dc.html. Every connection is optional and independent. */
export function ProjectIntegrations({ projectId }: { projectId: string }) {
  const [view, setView] = useState<Integrations>(); const [tool, setTool] = useState<ProjectTool>(); const [error, setError] = useState(''); const [open, setOpen] = useState<'github' | 'jira' | 'tool:new' | `tool:${string}`>();
  const load = useCallback(async () => {
    try { const [next, nextTool] = await Promise.all([api<Integrations>(base(projectId)), api<ProjectTool>(`${base(projectId)}/trackers`)]); setView(next); setTool(nextTool); setError(''); }
    catch (e) { if (e instanceof SignedOutError) onSignedOut(); else setError(message(e)); }
  }, [projectId]);
  useEffect(() => { setView(undefined); setTool(undefined); setOpen(undefined); void load(); }, [load]);
  if (!view || !tool) return error ? <><ErrorNote message={error} /><div><button type="button" class="btn" onClick={() => void load()}>Retry</button></div></> : <Skeleton rows={4} label="Loading integrations" />;
  const { github, jira } = view;
  const toggle = (kind: NonNullable<typeof open>) => setOpen(current => current === kind ? undefined : kind);
  const connected = tool.connections.find(c => open === `tool:${c.trackerId}`); const more = tool.trackers.length - tool.connections.length;
  return <section class="integ" aria-label="Integrations">
    <div><div style={{ fontWeight: 800, fontSize: '18px' }}>Integrations</div><div class="muted">All are optional. Each one needs a token, saved once and shared by your projects on the same account.</div></div>
    <div class="note info">This page saves and checks the connections. A task still ends in a local commit. With GitHub connected, \"After a task finishes\" below decides whether that commit becomes a pull request.</div>
    {view.secrets.locked && <div class="note warn" role="status">Credentials are locked after a restart. Run <Code>./devagents start</Code> to unlock them; until then tokens cannot be saved or checked.</div>}
    <div class="integ-tiles">
      <Tile kind="github" name="GitHub" what="The repository this folder was cloned from" connection={github} open={open === 'github'} onOpen={() => toggle('github')}
        line={github && <span class="mono">{github.repository}</span>}
        foot={github ? github.expiresAt ? `token valid until ${day(github.expiresAt)}` : `as @${github.login}` : view.folder.repository ? <span class="mono">{view.folder.repository}</span> : 'Needs a token'} />
      <Tile kind="jira" name="Jira" what="The tickets that may become tasks" connection={jira} open={open === 'jira'} onOpen={() => toggle('jira')}
        line={jira && (jira.rule ? <>project <b>{jira.rule.project.key}</b>{jira.rule.column ? <>, column <b>{jira.rule.column.name}</b></> : null}</> : 'no ticket rule yet')}
        foot={jira ? `as ${jira.account}${jira.expiresOn ? ` · token valid until ${day(`${jira.expiresOn}T00:00:00Z`)}` : ''}` : 'You write requests yourself'} />
      {tool.connections.map(c => <Tile key={c.trackerId} kind="tool" name={c.tracker.name} what="Ticket tool, through its MCP server" connection={c.tracker} open={open === `tool:${c.trackerId}`} onOpen={() => toggle(`tool:${c.trackerId}`)}
        line={c.rule ? ([c.rule.projects?.length ? `project ${c.rule.projects.map(p => p.name).join(', ')}` : '', c.rule.columns?.length ? `column ${c.rule.columns.join(', ')}` : '', c.rule.labels?.length ? `label ${c.rule.labels.join(', ')}` : '', c.rule.assignees?.length ? `assigned to ${c.rule.assignees.map(a => a.name).join(', ')}` : ''].filter(Boolean).join(' · ') || 'every ticket') : 'no ticket rule yet'}
        foot={c.tracker.account ? `as ${c.tracker.account}` : 'connected'} />)}
      <Tile kind="tool" name={tool.connections.length ? 'Another ticket tool' : 'Ticket tool'} what="Any Jira-like tool with an MCP server" connection={null} open={open === 'tool:new'} onOpen={() => toggle('tool:new')}
        line={null} foot={more > 0 ? `${more} added tool${more === 1 ? '' : 's'} to choose from` : tool.trackers.length ? 'Every added tool is in use here' : 'Add a tool first'} />
    </div>
    {connected && <ToolPanel key={connected.trackerId} projectId={projectId} view={tool} connection={connected} onChange={setTool} onConnected={() => undefined} />}
    {open === 'tool:new' && <ToolPanel key="new" projectId={projectId} view={tool} connection={undefined} onChange={setTool} onConnected={id => setOpen(`tool:${id}`)} />}
    {open === 'github' && <GitHubPanel projectId={projectId} view={view} onChange={setView} />}
    {open === 'jira' && <JiraPanel projectId={projectId} view={view} onChange={setView} />}
  </section>;
}
