import { useCallback, useEffect, useState } from 'preact/hooks';
import { api, SignedOutError, type Tool, type ToolInspection, type ToolList, type ToolMapping } from '../api';
import { Chip, Code, Empty, ErrorNote, Skeleton } from '../components/ui';
import { Logo, stateChip, useAction } from '../components/Integrations';
import { formatTime } from '../format';
import { onSignedOut } from '../state';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const FILTERS = [['project', 'project'], ['column', 'column'], ['label', 'label'], ['assignee', 'assignee']] as const;
const ANSWER = [['projects', 'Projects'], ['labels', 'Labels'], ['people', 'People']] as const;
/** The seven things DevAgents reads from a ticket (design/ui/U9-Tools.dc.html). Only the first two are required. */
const FIELDS = [['key', 'Ticket number', true], ['title', 'Title', true], ['url', 'Link', false], ['project', 'Project', false], ['column', 'Status', false], ['assignee', 'Assignee', false], ['labels', 'Label', false]] as const;
type Part = typeof FIELDS[number][0];
const GROUPS: readonly [string, readonly Part[]][] = [['To name the ticket and link back to it', ['key', 'title', 'url']], ['To choose which tickets come to DevAgents', ['project', 'column', 'assignee', 'labels']]];
const WITHOUT: Record<Part, string> = {
  key: 'Required. Without it a ticket cannot be told apart.', title: 'Required. Without it a ticket cannot be shown or named.', url: 'Not chosen. Tickets are shown without a link back.',
  project: 'Not chosen. Tickets cannot be picked by project unless the tool filters by it itself.', column: 'Not chosen. Tickets cannot be picked by status unless the tool filters by it itself.',
  assignee: 'Not chosen. Tickets cannot be picked by assignee.', labels: 'Not chosen. Tickets cannot be picked by label unless the tool filters by it itself.',
};
const blank = (tool: string): ToolMapping => ({ list: { tool, fixed: {}, filters: {} }, result: { tickets: '' }, ticket: { key: '', title: '' }, columns: [] });
/** Empty optional paths are left out, so the saved mapping names only what exists. */
function clean(draft: ToolMapping, columns: string): ToolMapping {
  const kept = <T extends Record<string, unknown>>(value: T) => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== '' && v !== undefined)) as T;
  return { list: { ...draft.list, filters: kept(draft.list.filters) }, result: kept(draft.result), ticket: kept(draft.ticket), columns: columns.split(',').map(c => c.trim()).filter(Boolean) };
}

/** A text field that offers the names found in the server's answer, and still takes one typed by hand. */
function PathField({ id, label, value, choices, required, disabled, onChange }: { id: string; label: string; value: string; choices: string[]; required?: boolean; disabled: boolean; onChange: (next: string) => void }) {
  return <><label for={id}>{label}{required ? '' : ' (optional)'}</label>
    <input id={id} type="text" list={`${id}-choices`} spellcheck={false} autocomplete="off" required={required} value={value} disabled={disabled} onInput={e => onChange((e.target as HTMLInputElement).value.trim())} />
    <datalist id={`${id}-choices`}>{choices.map(c => <option key={c} value={c} />)}</datalist></>;
}

/** Which of the server's tools lists tickets and where the fields are. DevAgents proposes it; the user confirms or corrects it. */
function MappingForm({ tool, first, onSaved }: { tool: Tool; first?: ToolInspection; onSaved: () => void }) {
  const [inspection, setInspection] = useState(first); const [loadError, setLoadError] = useState('');
  const [draft, setDraft] = useState<ToolMapping>(); const [columns, setColumns] = useState(''); const [note, setNote] = useState('');
  const action = useAction(); const id = `tool-${tool.id.slice(0, 8)}`;
  useEffect(() => {
    if (inspection) return;
    let current = true;
    api<ToolInspection>(`/trackers/${tool.id}/inspect`).then(next => { if (current) setInspection(next); }, e => { if (!current) return; if (e instanceof SignedOutError) onSignedOut(); else setLoadError(message(e)); });
    return () => { current = false; };
  }, [tool.id, inspection]);
  useEffect(() => {
    if (!inspection || draft) return;
    const start = tool.mapping ?? inspection.suggestion ?? blank(inspection.tools[0]?.name ?? '');
    setDraft(start); setColumns(start.columns.join(', '));
  }, [inspection]);
  if (!inspection || !draft) return loadError ? <div class="note bad" role="alert">{loadError}</div> : <Skeleton rows={4} label={`Asking ${tool.name} which tools it has`} />;
  const chosen = inspection.tools.find(t => t.name === draft.list.tool); const properties = Object.entries(chosen?.properties ?? {});
  const lists = inspection.shape?.lists ?? []; const fields = lists.find(l => l.path === draft.result.tickets)?.fields ?? [];
  const set = (change: (current: ToolMapping) => ToolMapping) => { setDraft(change(draft)); setNote(''); };
  const save = (event: Event) => {
    event.preventDefault(); setNote('');
    void action.run(async () => { const result = await api<{ tickets: number }>(`/trackers/${tool.id}/mapping`, { method: 'PUT', body: clean(draft, columns) }); setNote(`Saved. ${result.tickets} ticket${result.tickets === 1 ? '' : 's'} read from ${tool.name}.`); onSaved(); });
  };
  const sample = inspection.sample; const total = FIELDS.length; const set7 = FIELDS.filter(([part]) => draft.ticket[part]).length;
  // An id is shown by its name where the tool lists projects and people, so "p-12" reads as "Website".
  const example = (path: string | undefined) => { const raw = path ? sample?.values[path] ?? '' : ''; return sample?.names[raw.toLowerCase()] ?? raw; };
  const number = example(draft.ticket.key);
  return <form class="integ-col" onSubmit={save} aria-label={`Mapping for ${tool.name}`}>
    <div class="tool-head"><div class="h">2 · What DevAgents reads from a ticket</div>{number && <span class="hint">Read from ticket <b>{number}</b> just now</span>}</div>
    {set7 === total ? <div class="integ-match ok" role="status"><span aria-hidden="true">✓</span><span><b>{tool.mapped ? 'All seven fields are set.' : 'DevAgents found all seven by itself.'}</b> Change one only if the example on the right looks wrong.</span></div>
      : <div class="note warn" role="status">{set7} of {total} fields are set. {inspection.note ?? 'Choose the missing ones; a row says what does not work without it.'}</div>}
    <div class="tool-fields" role="group" aria-label="Fields read from a ticket">
      <span class="hd">DevAgents needs</span><span class="hd">Field in {tool.name}</span><span class="hd">From a real ticket</span><span class="hd" />
      {GROUPS.map(([title, parts]) => <>
        <span class="grp">{title}</span>
        {parts.map(part => {
          const [, word, required] = FIELDS.find(f => f[0] === part)!; const value = draft.ticket[part] ?? ''; const shown = example(value); const raw = sample?.values[value] ?? '';
          return <>
            <span class="need">{word}</span>
            <select aria-label={`Field for ${word}`} class={value ? '' : 'missing'} required={required} value={value} disabled={action.busy} onChange={e => set(d => ({ ...d, ticket: { ...d.ticket, [part]: (e.target as HTMLSelectElement).value } }))}>
              <option value="">Choose a field…</option>{[...new Set([...(value ? [value] : []), ...fields])].map(f => <option key={f} value={f}>{f}</option>)}</select>
            <span class={`eg${value ? '' : ' missing'}`}>{!value ? WITHOUT[part]
              : !shown ? <span class="muted">empty on this ticket</span>
              : part === 'url' && /^https?:\/\//.test(shown) ? <a href={shown} target="_blank" rel="noopener noreferrer">{shown.replace(/^https?:\/\//, '')}</a>
              : part === 'labels' ? shown.split(', ').map(l => <span key={l} class="tool-tag">{l}</span>)
              : shown !== raw ? <>{shown} <span class="muted">· {raw}</span></> : shown}</span>
            <span>{value ? <Chip tone="ok">✓ Found</Chip> : <Chip tone="warn">⚠ Missing</Chip>}</span>
          </>;
        })}
      </>)}
    </div>
    <div class="integ-actions"><button type="submit" class="btn primary" disabled={action.busy}>{action.busy ? `Checking with ${tool.name}…` : 'Save'}</button><span class="muted" style={{ fontSize: '13px' }} role="status">{note || (tool.mapped ? `Saved · checked ${formatTime(tool.checkedAt)}` : '')}</span></div>
    {action.error && <div class="note bad" role="alert">{action.error}</div>}
    <details class="tool-fold">
      <summary>How the tool is called · filled in automatically</summary>
      <div class="integ-cols">
        <div class="integ-col">
          <div class="h">Listing tickets</div>
          <div class="integ-rule tool-map">
            <label for={`${id}-list`}>List tickets with</label>
            <select id={`${id}-list`} required value={draft.list.tool} disabled={action.busy} onChange={e => set(d => ({ ...d, list: { tool: (e.target as HTMLSelectElement).value, fixed: {}, filters: {} } }))}>
              {!chosen && <option value={draft.list.tool}>{draft.list.tool || 'Choose a tool'}</option>}{inspection.tools.map(t => <option key={t.name} value={t.name}>{t.name}</option>)}</select>
            {properties.filter(([, p]) => p.choices.length > 0).map(([name, p]) => <>
              <label for={`${id}-fixed-${name}`}>Always send {name}</label>
              <select id={`${id}-fixed-${name}`} value={typeof draft.list.fixed[name] === 'string' ? draft.list.fixed[name] as string : ''} disabled={action.busy} onChange={e => set(d => { const { [name]: _, ...rest } = d.list.fixed; const value = (e.target as HTMLSelectElement).value; return { ...d, list: { ...d.list, fixed: value ? { ...rest, [name]: value } : rest } }; })}>
                <option value="">not sent</option>{p.choices.map(c => <option key={c} value={c}>{c}</option>)}</select></>)}
            {FILTERS.map(([part, word]) => <>
              <label for={`${id}-filter-${part}`}>Filter by {word} with</label>
              <select id={`${id}-filter-${part}`} value={draft.list.filters[part]?.name ?? ''} disabled={action.busy} onChange={e => set(d => { const { [part]: _, ...rest } = d.list.filters; const name = (e.target as HTMLSelectElement).value; return { ...d, list: { ...d.list, filters: name ? { ...rest, [part]: { name, many: chosen?.properties[name]?.many ?? false } } : rest } }; })}>
                <option value="">no argument · DevAgents filters the answer</option>{properties.filter(([, p]) => p.choices.length === 0).map(([name]) => <option key={name} value={name}>{name}</option>)}</select></>)}
          </div>
          {chosen?.description && <span class="hint">{chosen.name}: {chosen.description}</span>}
          <div class="h">Reading one ticket</div>
          <div class="integ-rule tool-map">
            <label for={`${id}-read`}>Read a ticket with</label>
            <select id={`${id}-read`} value={draft.read?.tool ?? ''} disabled={action.busy} onChange={e => set(d => { const { read: _, ...rest } = d; const name = (e.target as HTMLSelectElement).value; const single = Object.entries(inspection.tools.find(t => t.name === name)?.properties ?? {}).filter(([, p]) => !p.many).map(([key]) => key); return name ? { ...rest, read: { tool: name, key: single.find(key => /(id|key|number)$/i.test(key)) ?? single[0] ?? '' } } : rest; })}>
              <option value="">found by DevAgents when needed</option>{inspection.tools.map(t => <option key={t.name} value={t.name}>{t.name}</option>)}</select>
            {draft.read && <><label for={`${id}-read-key`}>Ticket number goes in</label>
              <select id={`${id}-read-key`} required value={draft.read.key} disabled={action.busy} onChange={e => set(d => ({ ...d, read: { tool: d.read!.tool, key: (e.target as HTMLSelectElement).value } }))}>
                {Object.keys(inspection.tools.find(t => t.name === draft.read!.tool)?.properties ?? {}).map(name => <option key={name} value={name}>{name}</option>)}</select></>}
          </div>
          <span class="hint">Used when a task is started from a ticket, to load its description, comments and files.</span>
        </div>
        <div class="integ-col">
          <div class="h">Where the lists are in the answer</div>
          <div class="integ-rule tool-map">
            <PathField id={`${id}-tickets`} label="Tickets are in" required value={draft.result.tickets} choices={lists.map(l => l.path)} disabled={action.busy} onChange={next => set(d => ({ ...d, result: { ...d.result, tickets: next } }))} />
            {ANSWER.map(([part, word]) => <PathField key={part} id={`${id}-${part}`} label={`${word} are in`} value={draft.result[part] ?? ''} choices={lists.map(l => l.path)} disabled={action.busy} onChange={next => set(d => ({ ...d, result: { ...d.result, [part]: next } }))} />)}
            <PathField id={`${id}-account`} label="Signed-in account is in" value={draft.result.account ?? ''} choices={inspection.shape?.values ?? []} disabled={action.busy} onChange={next => set(d => ({ ...d, result: { ...d.result, account: next } }))} />
          </div>
          <label class="field">Statuses a rule can name, in board order<input type="text" spellcheck={false} value={columns} disabled={action.busy} placeholder="todo, in-progress, done" onInput={e => { setColumns((e.target as HTMLInputElement).value); setNote(''); }} /></label>
          <span class="hint">Separate them with commas. Left empty, the statuses seen on tickets are offered.</span>
        </div>
      </div>
    </details>
  </form>;
}

function AddTool({ list, onAdded, onCancel }: { list: ToolList; onAdded: (inspection: ToolInspection) => void; onCancel: () => void }) {
  const [name, setName] = useState(''); const [url, setUrl] = useState(''); const [token, setToken] = useState(''); const action = useAction();
  const vault = list.secrets.mode === 'vault';
  const add = (event: Event) => { event.preventDefault(); void action.run(async () => onAdded(await api<ToolInspection>('/trackers', { method: 'POST', body: { name: name.trim(), url, ...(vault && token ? { token } : {}) } }))); };
  return <section class="card integ-panel" aria-label="Add a tool">
    <div class="integ-panel-head"><div class="integ-title"><Logo kind="tool" small />Add a tool</div>
      <div class="integ-steps" aria-hidden="true"><span class="on"><i>1</i>Connection</span><span>—</span><span><i>2</i>Ticket fields</span></div></div>
    <form class="integ-cols" onSubmit={add}>
      <div class="integ-col">
        <label class="field">Name<input type="text" required maxLength={60} value={name} disabled={action.busy} placeholder="For example Team board" onInput={e => setName((e.target as HTMLInputElement).value)} /></label>
        <label class="field">MCP server address<input type="text" spellcheck={false} required value={url} disabled={action.busy} placeholder="https://tracker.example.com/mcp" onInput={e => setUrl((e.target as HTMLInputElement).value.trim())} /></label>
        <span class="hint">The address the tool gives for MCP clients. It must use https; plain http is accepted only for a tool running on this computer (localhost). The token is only ever sent there.</span>
      </div>
      <div class="integ-col">
        {vault ? <><label class="field">Token<input type="password" autocomplete="off" spellcheck={false} required value={token} disabled={action.busy || list.secrets.locked} placeholder="Paste the tool's API key or token" onInput={e => setToken((e.target as HTMLInputElement).value.trim())} /></label>
          <span class="hint">A personal API key or access token of the tool. It is checked with the tool, stored encrypted and never shown again. DevAgents acts as the account it belongs to.</span></>
          : <div class="note info">This service has no encrypted vault, so a token cannot be pasted here. Name the tool, press Add, and DevAgents tells you which variable to set in the service's environment.</div>}
        <div class="integ-actions"><button type="submit" class="btn primary" disabled={action.busy || list.secrets.locked}>{action.busy ? 'Signing in…' : 'Add tool'}</button><button type="button" class="btn quiet" disabled={action.busy} onClick={onCancel}>Cancel</button></div>
        {action.error && <div class="note bad" role="alert">{action.error}</div>}
      </div>
    </form>
  </section>;
}

function ToolCard({ tool, list, first, open, onOpen, onChange }: { tool: Tool; list: ToolList; first?: ToolInspection; open: boolean; onOpen: () => void; onChange: () => void }) {
  const action = useAction(); const [token, setToken] = useState(''); const [editing, setEditing] = useState(false); const [removing, setRemoving] = useState(false);
  const [name, setName] = useState(tool.name); const [url, setUrl] = useState(tool.url); const vault = list.secrets.mode === 'vault';
  const edit = () => { setName(tool.name); setUrl(tool.url); setToken(''); action.clear(); setEditing(true); };
  const changed = name.trim() !== tool.name || url !== tool.url || Boolean(token);
  const save = (event: Event) => {
    event.preventDefault();
    void action.run(async () => {
      await api(`/trackers/${tool.id}`, { method: 'PUT', body: { ...(name.trim() !== tool.name ? { name: name.trim() } : {}), ...(url !== tool.url ? { url } : {}), ...(vault && token ? { token } : {}) } });
      setToken(''); setEditing(false); onChange();
    });
  };
  const chip = tool.mapped || tool.state !== 'connected' ? stateChip(tool) : { tone: 'warn' as const, text: '⚠ Needs mapping' };
  const used = tool.usedBy.map(p => p.name).join(', ');
  return <article class={`card integ-panel${open ? ' open' : ''}`} aria-label={`${tool.name}, ${chip.text.replace(/^[✓✕⚠] /, '').toLowerCase()}`}>
    <div class="integ-panel-head">
      <div class="integ-title"><Logo kind="tool" small />{tool.name}<Chip tone={chip.tone}>{chip.text}</Chip></div>
      <button type="button" class={`btn small${tool.mapped && tool.state === 'connected' ? '' : ' primary'}`} aria-expanded={open} onClick={onOpen}>{open ? 'Close' : tool.mapped ? 'Manage' : 'Finish mapping'}</button>
    </div>
    {!open && <div class="integ-summary">
      <span class="mono wrap-anywhere">{tool.url}</span>
      <span>{tool.account ? <>Acts as <b>{tool.account}</b> · </> : null}server {tool.server.name}{tool.server.version ? ` ${tool.server.version}` : ''}</span>
      <span class="muted">{used ? `Used by ${used}` : 'Not used by a project yet'} · checked {formatTime(tool.checkedAt)}</span>
    </div>}
    {tool.state === 'locked' && <div class="note warn" role="status">Credentials are locked after a restart. Run <Code>./devagents start</Code> to unlock them.</div>}
    {tool.problem && <div class="note bad" role="status">{tool.problem.message} <span class="muted">Checked {formatTime(tool.problem.at)}.</span></div>}
    {open && <>
      <div class="integ-col">
        <div class="h">1 · Connection</div>
        {editing ? <form class="integ-col" onSubmit={save} aria-label={`Edit ${tool.name}`}>
          <div class="integ-cols">
            <div class="integ-col">
              <label class="field">Name<input type="text" required maxLength={60} value={name} disabled={action.busy} onInput={e => setName((e.target as HTMLInputElement).value)} /></label>
              <label class="field">MCP server address<input type="text" spellcheck={false} required value={url} disabled={action.busy} onInput={e => setUrl((e.target as HTMLInputElement).value.trim())} /></label>
              <span class="hint">A new address is tried before it is saved. It must use https; plain http is accepted only for a tool running on this computer (localhost).</span>
            </div>
            <div class="integ-col">
              {vault ? <><label class="field">New token (optional)<input type="password" autocomplete="off" spellcheck={false} value={token} disabled={action.busy || list.secrets.locked} placeholder="Leave empty to keep the saved token" onInput={e => setToken((e.target as HTMLInputElement).value.trim())} /></label>
                <span class="hint">The saved token is never shown. Paste a new one only to replace it; it is checked with the tool first.</span></>
                : <div class="note info">The token comes from <Code>{tool.variable ?? 'the token variable'}</Code> in the service's environment. Change it there and restart the service.</div>}
            </div>
          </div>
          <div class="integ-actions"><button type="submit" class="btn primary" disabled={action.busy || !changed || list.secrets.locked}>{action.busy ? `Checking with ${name.trim() || tool.name}…` : 'Save changes'}</button><button type="button" class="btn quiet" disabled={action.busy} onClick={() => { setEditing(false); setToken(''); action.clear(); }}>Cancel</button></div>
        </form> : <>
          <div class="integ-ro"><span class="tool-line"><span class="mono">{tool.url}</span><span class="muted">{tool.account ? `· acts as ${tool.account} ` : ''}· {vault ? 'token saved' : 'token from the environment'}</span></span>
            <button type="button" class={`btn small${tool.state === 'rejected' || tool.state === 'unreachable' ? ' primary' : ''}`} aria-label="Edit connection" disabled={action.busy} onClick={edit}>Edit</button></div>
          <div class="integ-actions">
            <span class="muted" style={{ fontSize: '13px' }}>{used ? `Used by ${used}` : 'Not used by a project yet'} · checked {formatTime(tool.checkedAt)}</span>
            <button type="button" class="btn small quiet" disabled={action.busy || list.secrets.locked} onClick={() => void action.run(async () => { await api(`/trackers/${tool.id}/check`, { method: 'POST', body: {} }); onChange(); })}>{action.busy ? 'Checking…' : 'Check again'}</button>
            {removing ? <span class="integ-actions" role="group" aria-label={`Remove ${tool.name}?`}><span style={{ fontSize: '13px' }}>Remove {tool.name} and forget its token?</span><button type="button" class="btn small" disabled={action.busy} onClick={() => void action.run(async () => { await api(`/trackers/${tool.id}`, { method: 'DELETE' }); onChange(); })}>Yes, remove {tool.name}</button><button type="button" class="btn small quiet" disabled={action.busy} onClick={() => setRemoving(false)}>Keep</button></span>
              : <button type="button" class="btn small quiet" disabled={action.busy} onClick={() => setRemoving(true)}>Remove tool</button>}
          </div>
        </>}
        {action.error && <div class="note bad" role="alert">{action.error}</div>}
      </div>
      <MappingForm tool={tool} {...(first ? { first } : {})} onSaved={onChange} />
    </>}
  </article>;
}

/** Ticket tools with an MCP server. Design: design/ui/U9-Tools.dc.html. */
export function ToolsPage() {
  const [list, setList] = useState<ToolList>(); const [error, setError] = useState('');
  const [adding, setAdding] = useState(false); const [open, setOpen] = useState<string>(); const [first, setFirst] = useState<ToolInspection>();
  const load = useCallback(async () => {
    try { setList(await api<ToolList>('/trackers')); setError(''); }
    catch (e) { if (e instanceof SignedOutError) onSignedOut(); else setError(message(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return <>
    <div class="page-head"><div><div class="h">Tools</div><h1>Ticket tools</h1><p>Connect any Jira-like tool that has an MCP server. Add it once with its address and token; each project then chooses which of its tickets may become tasks.</p></div>
      {list && !adding && <button type="button" class="btn primary" onClick={() => setAdding(true)}>Add a tool</button>}</div>
    {!list ? error ? <><ErrorNote message={error} /><div><button type="button" class="btn" onClick={() => void load()}>Retry</button></div></> : <Skeleton rows={3} label="Loading tools" /> : <section class="integ" aria-label="Ticket tools">
      <div class="note info">This page saves and checks the connection and the mapping. DevAgents does not start tasks from tickets or write to the tool yet.</div>
      {list.secrets.locked && <div class="note warn" role="status">Credentials are locked after a restart. Run <Code>./devagents start</Code> to unlock them; until then tokens cannot be saved or checked.</div>}
      {adding && <AddTool list={list} onCancel={() => setAdding(false)} onAdded={inspection => { setFirst(inspection); setOpen(inspection.tracker.id); setAdding(false); void load(); }} />}
      {list.trackers.length === 0 && !adding && <Empty title="No tool is added yet">Add one to let projects pick up tickets from it.</Empty>}
      {list.trackers.map(tool => <ToolCard key={tool.id} tool={tool} list={list} {...(first?.tracker.id === tool.id ? { first } : {})} open={open === tool.id} onOpen={() => setOpen(current => current === tool.id ? undefined : tool.id)} onChange={() => void load()} />)}
    </section>}
  </>;
}
