import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { api, SignedOutError, type ConnectionState, type GitHubConnection, type Integrations, type JiraConnection, type JiraMatches, type JiraRuleInput, type SavedToken } from '../api';
import { formatTime, type Tone } from '../format';
import { onSignedOut } from '../state';
import { Chip, Code, ErrorNote, Skeleton } from './ui';
import { Autocomplete, type Choice } from './Autocomplete';

type Kind = 'github' | 'jira';
const base = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/integrations`;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const days = (n: number) => n === 0 ? 'today' : n === 1 ? 'in 1 day' : `in ${n} days`;

function stateChip(c: { state: ConnectionState; expiresInDays?: number }): { tone: Tone; text: string } {
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
const Logo = ({ kind, small }: { kind: Kind; small?: boolean }) => <span class={`integ-logo ${kind}${small ? ' small' : ''}`} aria-hidden="true">
  <svg width={small ? 19 : 24} height={small ? 19 : 24} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    {kind === 'github' ? <><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="8" r="2.5" /><path d="M6 8.5v7M18 10.5c0 4-6 3-11.5 5.5" /></> : <><rect x="4" y="4" width="16" height="16" rx="3" /><path d="m8.5 12 2.5 2.5 4.5-5" /></>}
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
function useAction() {
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
const others = (view: Integrations, kind: Kind): Using[] => view.savedTokens[kind].find(t => t.id === view[kind]?.savedToken)?.usedBy.filter(p => p.id !== view.projectId) ?? [];
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
  const filtered = Boolean(column || assignee || label.trim());
  useEffect(() => {
    const id = ++sequence.current;
    if (!usable || !key || !filtered) { setMatches({ state: 'idle' }); return; }
    setMatches({ state: 'loading' });
    const timer = setTimeout(() => {
      api<{ matches: JiraMatches }>(`${base(projectId)}/jira/preview`, { method: 'POST', body: rule }).then(
        result => { if (id === sequence.current) setMatches({ state: 'ok', value: result.matches }); },
        e => { if (id !== sequence.current) return; if (e instanceof SignedOutError) onSignedOut(); else setMatches({ state: 'bad', text: message(e) }); });
    }, 400);
    return () => clearTimeout(timer);
  }, [projectId, key, column, assignee?.id, label, usable]);

  const changeProject = (next: Choice | undefined) => { setProject(next); setColumn(''); setAssignee(undefined); setLabel(''); setNote(''); };
  const unchanged = Boolean(saved) && saved!.project.key === key && (saved!.column?.name ?? '') === column && (saved!.assignee?.id ?? '') === (assignee?.id ?? '') && (saved!.label ?? '') === label.trim() && saved!.start === start;
  const save = (event: Event) => {
    event.preventDefault(); setNote('');
    void action.run(async () => { onChange((await api<{ integrations: Integrations }>(`${base(projectId)}/jira/rule`, { method: 'PUT', body: rule })).integrations); setNote('Rule saved.'); });
  };
  if (!usable) return <div class="integ-col"><div class="h">2 · Which tickets</div><span class="muted" style={{ fontSize: '13.5px' }}>Tickets can be chosen again once the token works.{saved ? ` The saved rule for ${saved.project.key} is kept.` : ''}</span></div>;
  const kind = columns?.columnsFrom === 'statuses' ? 'status' : 'column';
  return <form class="integ-col" onSubmit={save} aria-label="Which tickets">
    <div class="h">2 · Which tickets</div>
    <div class="field"><label for="integ-rule-project">Pick up tickets from project</label>
      <Autocomplete id="integ-rule-project" what="project" value={project} onChange={changeProject} search={suggest('projects')} placeholder="Type a project name or key" disabled={action.busy} describe={c => `${c.id} · ${c.name}`} /></div>
    {!project ? <span class="muted" style={{ fontSize: '13.5px' }}>Choose the Jira project, then narrow it down by column, assignee or label.</span> : <>
      {loadError && <div class="note bad" role="alert">{loadError}</div>}
      <div class="integ-rule" role="group" aria-label="Filters, all optional">
        <label for="integ-rule-column">in {kind}</label>
        <select id="integ-rule-column" value={column} disabled={action.busy || !columns} onChange={e => { setColumn((e.target as HTMLSelectElement).value); setNote(''); }}><option value="">{columns ? `any ${kind}` : loadError ? 'not available' : 'loading…'}</option>{[...new Set([...(column ? [column] : []), ...(columns?.columns.map(c => c.name) ?? [])])].map(name => <option key={name} value={name}>{name}</option>)}</select>
        <label for="integ-rule-assignee">assigned to</label>
        <Autocomplete id="integ-rule-assignee" what="assignee" value={assignee} onChange={next => { setAssignee(next); setNote(''); }} search={suggest('people')} placeholder="anyone" disabled={action.busy} />
        <label for="integ-rule-label">with label</label>
        <Autocomplete id="integ-rule-label" what="label" free value={label ? { id: label, name: label } : undefined} onChange={next => { setLabel(next?.id ?? ''); setNote(''); }} search={suggest('labels')} placeholder="any label" disabled={action.busy} />
      </div>
      <MatchLine filtered={filtered} preview={matches} approximate={jira.kind === 'cloud'} />
      <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <legend style={{ fontSize: '13px', fontWeight: 700, padding: 0, marginBottom: '6px' }}>When a ticket matches</legend>
        <label class="integ-radio"><input type="radio" name="integ-rule-start" checked={start === 'manual'} disabled={action.busy} onChange={() => { setStart('manual'); setNote(''); }} /><span><b>Wait until someone starts it</b> <span class="muted">· recommended</span></span></label>
        <label class="integ-radio"><input type="radio" name="integ-rule-start" checked={start === 'auto'} disabled={action.busy} onChange={() => { setStart('auto'); setNote(''); }} /><span>Start on its own</span></label>
      </fieldset>
      <div class="integ-actions"><button type="submit" class="btn primary" disabled={action.busy || !filtered || unchanged}>{action.busy ? 'Saving…' : 'Save rule'}</button>
        <span class="muted" style={{ fontSize: '13px' }} role="status">{note || (unchanged ? `Saved ${formatTime(saved!.savedAt)}` : '')}</span></div>
      {action.error && <div class="note bad" role="alert">{action.error}</div>}
    </>}
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
      </div><p class="hint" style={{ margin: '8px 0 0' }}>If you create a token "with scopes", choose the app <b>Jira</b> and the scopes <span class="mono">read:jira-work</span> and <span class="mono">read:jira-user</span>. The plain token needs no choices.</p></>
        : <div class="integ-how" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}><div><i>1</i><span>In Jira, open your <b>Profile → Personal access tokens</b>, create a token named "DevAgents" and paste it here.</span></div></div>}
    </div>}
  </section>;
}

/** Design: design/ui/U8-Integrations.dc.html. Both connections are optional and independent. */
export function ProjectIntegrations({ projectId }: { projectId: string }) {
  const [view, setView] = useState<Integrations>(); const [error, setError] = useState(''); const [open, setOpen] = useState<Kind>();
  const load = useCallback(async () => {
    try { setView(await api<Integrations>(base(projectId))); setError(''); }
    catch (e) { if (e instanceof SignedOutError) onSignedOut(); else setError(message(e)); }
  }, [projectId]);
  useEffect(() => { setView(undefined); setOpen(undefined); void load(); }, [load]);
  if (!view) return error ? <><ErrorNote message={error} /><div><button type="button" class="btn" onClick={() => void load()}>Retry</button></div></> : <Skeleton rows={4} label="Loading integrations" />;
  const { github, jira } = view;
  const toggle = (kind: Kind) => setOpen(current => current === kind ? undefined : kind);
  return <section class="integ" aria-label="Integrations">
    <div><div style={{ fontWeight: 800, fontSize: '18px' }}>Integrations</div><div class="muted">Both are optional. Each one needs a token, saved once and shared by your projects on the same account.</div></div>
    <div class="note info">This page saves and checks the two connections. DevAgents does not open pull requests or start tasks from tickets yet; tasks still end in a local commit.</div>
    {view.secrets.locked && <div class="note warn" role="status">Credentials are locked after a restart. Run <Code>./devagents start</Code> to unlock them; until then tokens cannot be saved or checked.</div>}
    <div class="integ-tiles">
      <Tile kind="github" name="GitHub" what="The repository this folder was cloned from" connection={github} open={open === 'github'} onOpen={() => toggle('github')}
        line={github && <span class="mono">{github.repository}</span>}
        foot={github ? github.expiresAt ? `token valid until ${day(github.expiresAt)}` : `as @${github.login}` : view.folder.repository ? <span class="mono">{view.folder.repository}</span> : 'Needs a token'} />
      <Tile kind="jira" name="Jira" what="The tickets that may become tasks" connection={jira} open={open === 'jira'} onOpen={() => toggle('jira')}
        line={jira && (jira.rule ? <>project <b>{jira.rule.project.key}</b>{jira.rule.column ? <>, column <b>{jira.rule.column.name}</b></> : null}</> : 'no ticket rule yet')}
        foot={jira ? `as ${jira.account}${jira.expiresOn ? ` · token valid until ${day(`${jira.expiresOn}T00:00:00Z`)}` : ''}` : 'You write requests yourself'} />
    </div>
    {open === 'github' && <GitHubPanel projectId={projectId} view={view} onChange={setView} />}
    {open === 'jira' && <JiraPanel projectId={projectId} view={view} onChange={setView} />}
  </section>;
}
