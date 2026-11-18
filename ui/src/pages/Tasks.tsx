import { useEffect, useRef, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { api, resources, teamLabel, type AvailableTicket, type AvailableTickets, type TaskSummary, type TaskState } from '../api';
import { Card, Empty, ErrorNote, Skeleton, StateChip } from '../components/ui';
import { activeStates, attentionStates, finishedStates, relative, truncate } from '../format';
import { useNow, usePoll } from '../state';

type Group = 'all' | 'attention' | 'active' | 'finished';
type View = 'board' | 'list';
type TaskPage = { tasks: TaskSummary[]; nextBefore?: number; counts: Record<string, number> };
const groups: Record<Group, TaskState[] | undefined> = { all: undefined, attention: attentionStates, active: activeStates, finished: finishedStates };
/** Remembered per browser; a missing or blocked store just means the default. */
const remembered = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const remember = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* the choice lasts for this visit only */ } };
/** Where "Start task" hands a ticket to the submit form. Session storage keeps ticket text out of the address. */
export const TICKET_PREFILL = 'devagents.submit.ticket';

// The board (design/ui/U10-Tasks-Board.dc.html): stages left to right, and what waits for the user lifted into a band above.
const WAITING: TaskState[] = ['awaiting_mode', 'awaiting_plan_approval', 'awaiting_external_approval'];
const STAGES: { id: string; name: string; states: TaskState[]; folds?: boolean }[] = [
  { id: 'planning', name: 'Planning', states: ['draft', 'planning'] },
  { id: 'queued', name: 'Queued', states: ['ready'] },
  { id: 'working', name: 'Working', states: ['running', 'validating', 'reviewing', 'repairing', 'committing'] },
  { id: 'done', name: 'Done', states: ['completed'], folds: true },
  { id: 'stopped', name: 'Stopped', states: ['failed', 'cancelled'], folds: true },
];
const OPEN: TaskState[] = [...WAITING, ...STAGES.filter(s => !s.folds).flatMap(s => s.states)];
const FOLDED = 8;
const query = (states: TaskState[], limit: number, project: string) => `/tasks?limit=${limit}${project ? `&projectId=${encodeURIComponent(project)}` : ''}${states.map(state => `&state=${state}`).join('')}`;
const has = (text: string, search: string) => !search || text.toLowerCase().includes(search.toLowerCase());

/** One line about what is happening to the task, from what the summary already carries. */
function detail(t: TaskSummary): string {
  if (t.scheduling && ['queued', 'held', 'draining'].includes(t.scheduling.status)) return t.scheduling.reason;
  if (t.commit) return `${t.commit.slice(0, 7)}${t.branch ? ` · ${t.branch}` : ''}`;
  if (t.error) return truncate(t.error, 90);
  if (t.items) return `${t.items} work item${t.items === 1 ? '' : 's'} planned`;
  return t.mode ?? 'mode not chosen';
}
function TaskCard({ task, now }: { task: TaskSummary; now: number }) {
  return <a class="kb-card" href={`/ui/tasks/${task.id}`}>
    <span class="kb-title wrap-anywhere">{truncate(task.request, 140)}</span>
    <StateChip task={task} />
    <span class={`kb-line${task.commit ? ' mono' : ''}`}>{detail(task)}</span>
    <span class="kb-meta"><span class="kb-project">{task.projectName ?? task.projectId}</span><span>{relative(task.updatedAt, now)}</span></span>
  </a>;
}
const waitingAction = (state: TaskState) => state === 'awaiting_plan_approval' ? { why: 'The plan waits for your approval', action: 'Review the plan' } : state === 'awaiting_mode' ? { why: 'Choose how it should run', action: 'Choose the mode' } : { why: 'Waits for an approval', action: 'Open the task' };
function NeedsYou({ tasks, now }: { tasks: TaskSummary[]; now: number }) {
  if (!tasks.length) return null;
  return <section class="kb-you" aria-label={`Needs you, ${tasks.length} task${tasks.length === 1 ? '' : 's'}`}>
    <div class="kb-you-head"><b>Needs you</b><span class="kb-count">{tasks.length}</span></div>
    <div class="kb-you-cards">{tasks.map(task => { const { why, action } = waitingAction(task.state); return <div key={task.id} class="kb-ycard">
      <span class="kb-ytitle">{truncate(task.request, 110)}</span>
      <a class="btn primary small" href={`/ui/tasks/${task.id}`}>{action}</a>
      <span class="kb-why"><span aria-hidden="true">● </span>{why}</span>
      <span class="kb-ymeta">{task.projectName ?? task.projectId} · {relative(task.updatedAt, now)}</span>
    </div>; })}</div>
  </section>;
}

const Pin = ({ on }: { on: boolean }) => <svg width="15" height="15" viewBox="0 0 24 24" fill={on ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3z" /><path d="M12 14v7" fill="none" /></svg>;
function TicketCard({ ticket }: { ticket: AvailableTicket }) {
  const { route } = useLocation();
  const start = () => {
    const request = `${ticket.key}: ${ticket.title}${ticket.url ? `\n\nTicket: ${ticket.url}` : ''}`;
    try { sessionStorage.setItem(TICKET_PREFILL, JSON.stringify({ projectId: ticket.projectId, request, key: ticket.key, source: ticket.source.name, sourceId: ticket.source.id, ...(ticket.url ? { url: ticket.url } : {}) })); } catch { /* the form opens with the project only */ }
    route(`/ui/tasks/new?project=${encodeURIComponent(ticket.projectId)}`);
  };
  // The whole card opens the form; the ticket link and the button inside keep their own behaviour.
  return <div class="kb-card kb-ticket" onClick={e => { if (!(e.target as HTMLElement).closest('a, button')) start(); }}>
    <span class="kb-src"><i class={ticket.source.kind} aria-hidden="true">{ticket.source.kind === 'jira' ? 'J' : 'T'}</i>{ticket.source.name} · {ticket.url ? <a href={ticket.url} target="_blank" rel="noopener noreferrer">{ticket.key}</a> : <span class="mono">{ticket.key}</span>}</span>
    <span class="kb-title wrap-anywhere">{ticket.title}</span>
    {ticket.why && <span class="kb-line">{ticket.why}</span>}
    <button type="button" class="btn small kb-start" onClick={start}>Start task</button>
    <span class="kb-meta"><span class="kb-project">for {ticket.projectName}</span></span>
  </div>;
}
/**
 * Tickets from Jira and the ticket tools that match a project's rule and have no task yet. The pin
 * in its corner keeps the column open; unpinned it folds to a strip that opens over the board while
 * the pointer or the keyboard focus is on it.
 */
function Available({ project, search }: { project: string; search: string }) {
  const [pinned, setPinned] = useState(() => remembered('devagents.tasks.availablePinned') !== 'false'); const [peek, setPeek] = useState(false);
  const data = usePoll('tickets:available', () => api<AvailableTickets>('/tickets/available', { timeoutMs: 60000 }), 60000);
  const tickets = (data.data?.tickets ?? []).filter(t => (!project || t.projectId === project) && has(`${t.key} ${t.title}`, search));
  const problems = (data.data?.problems ?? []);
  const toggle = () => { const next = !pinned; setPinned(next); setPeek(false); remember('devagents.tasks.availablePinned', String(next)); };
  const count = data.data ? String(tickets.length) : '…';
  const column = <section class={`kb-col kb-avail${pinned ? '' : ' kb-over'}`} aria-label={`Available, ${count} ticket${tickets.length === 1 ? '' : 's'}`}>
    <div class="kb-col-head"><b>Available</b><span class="kb-head-end"><span class="kb-count">{count}</span>
      <button type="button" class={`kb-pin${pinned ? ' on' : ''}`} aria-pressed={pinned} aria-label={pinned ? 'Available stays open. Press to let it collapse' : 'Available collapses. Press to keep it open'} title={pinned ? 'Pinned · stays open' : 'Not pinned · opens on hover'} onClick={toggle}><Pin on={pinned} /></button></span></div>
    <div class="kb-cards">
      {data.error && !data.data ? <span class="kb-none">{data.error}</span> : !data.data ? <span class="kb-none">Asking Jira and the ticket tools…</span>
        : tickets.length === 0 ? <span class="kb-none">No tickets waiting</span> : tickets.map(t => <TicketCard key={`${t.projectId}:${t.source.name}:${t.key}`} ticket={t} />)}
      {problems.map(p => <span key={`${p.projectName}:${p.source}`} class="kb-problem">{p.source} for {p.projectName}: {p.message}</span>)}
    </div>
  </section>;
  if (pinned) return column;
  return <div class="kb-rail-wrap" onMouseEnter={() => setPeek(true)} onMouseLeave={() => setPeek(false)} onFocusIn={() => setPeek(true)} onFocusOut={e => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setPeek(false); }} onKeyDown={e => { if (e.key === 'Escape') { setPeek(false); (e.currentTarget.querySelector('.kb-rail') as HTMLElement | null)?.focus(); } }}>
    <button type="button" class="kb-rail" aria-expanded={peek} aria-label={`Available, ${count} tickets. Open`} onClick={() => setPeek(true)}>
      <span class="kb-count">{count}</span><span class="kb-rail-name">Available</span>
    </button>
    {peek && column}
  </div>;
}

function Board({ project, search, now, onOlder }: { project: string; search: string; now: number; onOlder: () => void }) {
  const open = usePoll(`board:open:${project}`, () => api<TaskPage>(query(OPEN, 200, project)), 5000);
  const done = usePoll(`board:done:${project}`, () => api<TaskPage>(query(['completed'], FOLDED, project)), 5000);
  const stopped = usePoll(`board:stopped:${project}`, () => api<TaskPage>(query(['failed', 'cancelled'], FOLDED, project)), 5000);
  const error = open.error ?? done.error ?? stopped.error;
  if (!open.data || !done.data || !stopped.data) return error ? <ErrorNote message={error} /> : <Skeleton rows={5} label="Loading tasks" />;
  const counts = open.data.counts; const shown = (tasks: TaskSummary[]) => tasks.filter(t => has(t.request, search));
  const folded: Record<string, TaskSummary[]> = { done: done.data.tasks, stopped: stopped.data.tasks };
  const waiting = shown(open.data.tasks.filter(t => WAITING.includes(t.state)));
  return <>
    <NeedsYou tasks={waiting} now={now} />
    <div class="kb-board" aria-label="Tickets and tasks by stage">
      <Available project={project} search={search} />
      {STAGES.map(stage => {
        const tasks = shown(stage.folds ? folded[stage.id]! : open.data!.tasks.filter(t => stage.states.includes(t.state)));
        const total = stage.states.reduce((sum, state) => sum + (counts[state] ?? 0), 0); const older = stage.folds ? total - folded[stage.id]!.length : 0;
        return <section key={stage.id} class="kb-col" aria-label={`${stage.name}, ${total} task${total === 1 ? '' : 's'}`}>
          <div class="kb-col-head"><b>{stage.name}</b><span class="kb-count">{total}</span></div>
          <div class="kb-cards">
            {tasks.length === 0 ? <span class="kb-none">No tasks here</span> : tasks.map(task => <TaskCard key={task.id} task={task} now={now} />)}
            {older > 0 && <button type="button" class="kb-more" onClick={onOlder}>Show {older} older →</button>}
          </div>
        </section>;
      })}
    </div>
  </>;
}

function List({ project, search, group, setGroup, now }: { project: string; search: string; group: Group; setGroup: (next: Group) => void; now: number }) {
  const [before, setBefore] = useState<number[]>([]);
  useEffect(() => { setBefore([]); }, [project, group]);
  const cursor = before[before.length - 1];
  const path = `/tasks?limit=50${cursor ? `&before=${cursor}` : ''}${project ? `&projectId=${encodeURIComponent(project)}` : ''}${(groups[group] ?? []).map(state => `&state=${state}`).join('')}`;
  const page = usePoll(`tasks:${path}`, () => api<TaskPage>(path), 5000);
  const tasks = (page.data?.tasks ?? []).filter(t => has(t.request, search));
  const count = (g: Group) => { const counts = page.data?.counts ?? {}; return (groups[g] ?? Object.keys(counts)).reduce((total, state) => total + (counts[state] ?? 0), 0); };
  return <>
    <div class="filters" role="group" aria-label="State">
      <span class="muted" style={{ fontSize: '13px', fontWeight: 600 }}>State</span>
      {(['all', 'attention', 'active', 'finished'] as Group[]).map(g => <button key={g} type="button" class="filter" aria-pressed={group === g} onClick={() => setGroup(g)}>{{ all: 'All', attention: 'Needs you', active: 'Active', finished: 'Finished' }[g]} · {count(g)}</button>)}
    </div>
    {page.error && !page.data && <ErrorNote message={page.error} />}
    {!page.data && !page.error ? <Skeleton rows={5} label="Loading tasks" /> : page.data && <Card foot={<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
      <span>Showing {tasks.length} of {page.data.tasks.length} on this page · newest first{before.length ? ` · page ${before.length + 1}` : ''}</span>
      <span style={{ display: 'flex', gap: '8px' }}>
        <button type="button" class="filter" disabled={before.length === 0} onClick={() => setBefore(b => b.slice(0, -1))}>← Newer</button>
        <button type="button" class="filter" disabled={!page.data.nextBefore} onClick={() => setBefore(b => [...b, page.data!.nextBefore!])}>Older →</button>
      </span></div>}>
      {tasks.length === 0 ? <Empty title={count('all') === 0 ? 'No tasks yet' : 'No tasks match these filters'}>{count('all') === 0 && <span>Submit work with <code>devagents tasks submit &lt;project&gt; "&lt;request&gt;"</code></span>}</Empty> : <div class="scroll-x"><table>
        <thead><tr><th>Request</th><th>Project</th><th>State</th><th>Items</th><th>Updated</th><th>Branch / result</th></tr></thead>
        <tbody>{tasks.map(t => <tr key={t.id} class="row">
          <td><a href={`/ui/tasks/${t.id}`} style={{ fontWeight: 700, color: 'var(--text)', textDecoration: 'none' }} class="wrap-anywhere">{truncate(t.request, 110)}</a><div class="muted wrap-anywhere" style={{ fontSize: '12.5px' }}>{t.mode ?? 'mode not chosen'} · v{t.version} · <span class="mono">{t.id.slice(0, 8)}</span> · {teamLabel(t.team)}</div></td>
          <td class="wrap-anywhere">{t.projectName ?? t.projectId}</td><td><StateChip task={t} />{t.scheduling && ['queued', 'held', 'draining'].includes(t.scheduling.status) && <div class="muted wrap-anywhere" style={{ fontSize: '12px' }}>{t.scheduling.reason}</div>}{t.limitations ? <div class="muted" style={{ fontSize: '12px', marginTop: '4px' }}>{t.limitationOverflow ? 'At least ' : ''}{t.limitations} check{t.limitations === 1 ? '' : 's'} not run here</div> : null}</td><td class="mono">{t.items ? `${t.items} planned` : '—'}</td><td class="muted">{relative(t.updatedAt, now)}</td>
          <td class={t.commit ? 'mono' : 'muted'}>{t.commit ? `${t.commit.slice(0, 7)} · ${t.branch ?? ''}` : t.error ? truncate(t.error, 100) : t.branch ? <span class="mono">{t.branch}</span> : '—'}</td>
        </tr>)}</tbody></table></div>}
    </Card>}
  </>;
}

export function TasksPage() {
  const now = useNow(); const params = useRef(new URLSearchParams(location.search)).current;
  const projects = usePoll(resources.projects.key, resources.projects.load, resources.projects.intervalMs).data;
  const asked = params.get('group'); const askedGroup = asked && Object.hasOwn(groups, asked) ? asked as Group : undefined;
  // A link to a state group means the list; otherwise the last chosen view, and the board the first time.
  const [view, setView] = useState<View>(() => { const v = params.get('view'); return v === 'list' || v === 'board' ? v : askedGroup ? 'list' : remembered('devagents.tasks.view') === 'list' ? 'list' : 'board'; });
  const [group, setGroup] = useState<Group>(askedGroup ?? 'all'); const [project, setProject] = useState(''); const [search, setSearch] = useState('');
  const choose = (next: View) => { setView(next); remember('devagents.tasks.view', next); };
  return <>
    <div class="page-head">
      <div><div class="h">Tasks</div><h1>All tasks</h1></div>
      <a class="btn primary" href="/ui/tasks/new">Submit work</a>
    </div>
    <div class="filters" role="group" aria-label="View and filters">
      <span class="kb-seg" role="group" aria-label="View">{(['board', 'list'] as View[]).map(v => <button key={v} type="button" aria-pressed={view === v} onClick={() => choose(v)}>{v === 'board' ? 'Board' : 'List'}</button>)}</span>
      <label class="search"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5A5F78" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg><span class="sr-only">Search request text on this page</span><input type="search" placeholder="Search this page" value={search} onInput={e => setSearch((e.target as HTMLInputElement).value)} /></label>
      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', fontWeight: 600, color: 'var(--muted)' }}>Project <select value={project} onChange={e => setProject((e.target as HTMLSelectElement).value)} style={{ minHeight: '34px', borderRadius: '999px', border: '1px solid var(--btn-border)', backgroundColor: '#fff', font: 'inherit', paddingBlock: '0', paddingLeft: '10px' }}>
        <option value="">All</option>{(projects ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select></label>
    </div>
    {view === 'board' ? <Board project={project} search={search} now={now} onOlder={() => { setGroup('finished'); choose('list'); }} />
      : <List project={project} search={search} group={group} setGroup={setGroup} now={now} />}
  </>;
}
