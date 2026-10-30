import { useState } from 'preact/hooks';
import { api, resources, teamLabel, type TaskSummary, type TaskState } from '../api';
import { Card, Empty, ErrorNote, Later, Skeleton, StateChip } from '../components/ui';
import { activeStates, attentionStates, finishedStates, relative, truncate } from '../format';
import { useNow, usePoll } from '../state';

type Group = 'all' | 'attention' | 'active' | 'finished';
const groups: Record<Group, TaskState[] | undefined> = { all: undefined, attention: attentionStates, active: activeStates, finished: finishedStates };

export function TasksPage() {
  const now = useNow();
  const projects = usePoll(resources.projects.key, resources.projects.load, resources.projects.intervalMs).data;
  const [group, setGroup] = useState<Group>(() => { const value = new URLSearchParams(location.search).get('group'); return value && Object.hasOwn(groups, value) ? value as Group : 'all'; }); const [project, setProject] = useState<string>(''); const [search, setSearch] = useState('');
  const [before, setBefore] = useState<number[]>([]);
  const cursor = before[before.length - 1];
  const query = `/tasks?limit=50${cursor ? `&before=${cursor}` : ''}${project ? `&projectId=${encodeURIComponent(project)}` : ''}${(groups[group] ?? []).map(state => `&state=${state}`).join('')}`;
  const page = usePoll(`tasks:${query}`, () => api<{ tasks: TaskSummary[]; nextBefore?: number; counts: Record<string, number> }>(query), 5000);
  const tasks = (page.data?.tasks ?? []).filter(t => !search || t.request.toLowerCase().includes(search.toLowerCase()));
  const count = (g: Group) => { const counts = page.data?.counts ?? {}; return (groups[g] ?? Object.keys(counts)).reduce((total, state) => total + (counts[state] ?? 0), 0); };
  return <>
    <div class="page-head">
      <div><div class="h">Tasks</div><h1>All tasks</h1><p>Summaries only; open a task for its plan, work items, activity and result.</p></div>
      <a class="btn primary" href="/ui/tasks/new">Submit work</a>
    </div>
    <div class="filters" role="group" aria-label="Filters">
      <label class="search"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5A5F78" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg><span class="sr-only">Search request text on this page</span><input type="search" placeholder="Search this page" value={search} onInput={e => setSearch((e.target as HTMLInputElement).value)} /></label>
      <span class="muted" style={{ fontSize: '13px', fontWeight: 600 }}>State</span>
      {(['all', 'attention', 'active', 'finished'] as Group[]).map(g => <button key={g} type="button" class="filter" aria-pressed={group === g} onClick={() => { setGroup(g); setBefore([]); }}>{{ all: 'All', attention: 'Needs you', active: 'Active', finished: 'Finished' }[g]} · {count(g)}</button>)}
      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', fontWeight: 600, color: 'var(--muted)' }}>Project <select value={project} onChange={e => { setProject((e.target as HTMLSelectElement).value); setBefore([]); }} style={{ minHeight: '34px', borderRadius: '999px', border: '1px solid var(--btn-border)', background: '#fff', font: 'inherit', padding: '0 10px' }}>
        <option value="">All</option>{(projects ?? []).map(p => <option key={p.id} value={p.id}>{p.id}</option>)}
      </select></label>
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
          <td class="mono">{t.projectId}</td><td><StateChip task={t} /></td><td class="mono">{t.items ? `${t.items} planned` : '—'}</td><td class="muted">{relative(t.updatedAt, now)}</td>
          <td class={t.commit ? 'mono' : 'muted'}>{t.commit ? `${t.commit.slice(0, 7)} · ${t.branch ?? ''}` : t.error ? truncate(t.error, 100) : t.branch ? <span class="mono">{t.branch}</span> : '—'}</td>
        </tr>)}</tbody></table></div>}
    </Card>}
  </>;
}
