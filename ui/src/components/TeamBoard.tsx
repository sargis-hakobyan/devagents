import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { Stage } from './ui';
import { fold, statusBadge, statusLabel, duration, clock, type BoardMember, type BoardRole, type BoardStatus, type TeamBoard } from '../team-board';

/** Role glyphs: a list for the lead, code brackets for developers, a magnifier for reviewers, a flask for QA, a person for you, the spark for DevAgents. */
function Glyph({ role, size }: { role: BoardRole; size: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true } as const;
  const stroke = { fill: 'none', stroke: 'currentColor', 'stroke-width': 2.2, 'stroke-linecap': 'round' as const };
  switch (role) {
    case 'lead': return <svg {...common} {...stroke}><path d="M5 6h14M5 12h9M5 18h6" /><circle cx="18" cy="17" r="3" /></svg>;
    case 'reviewer': return <svg {...common} {...stroke}><circle cx="10.5" cy="10.5" r="6.5" /><path d="m20 20-4.8-4.8M8 10.5l1.8 1.8 3.2-3.4" /></svg>;
    case 'qa': return <svg {...common} {...stroke}><path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-9V3" /></svg>;
    case 'you': return <svg {...common} {...stroke}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>;
    case 'system': return <svg {...common} fill="currentColor"><path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z" /></svg>;
    default: return <svg {...common} {...stroke}><path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16" /></svg>;
  }
}
export function Avatar({ role, status, size = 'sm', repairing }: { role: BoardRole; status: BoardStatus; size?: 'lg' | 'sm' | 'xs'; repairing?: boolean }) {
  const px = size === 'lg' ? 26 : size === 'sm' ? 20 : 14;
  return <span class={`avatar ${size} ${status}`} title={statusLabel[status]}><Glyph role={role} size={px} />{size !== 'xs' && <span class={`abadge ${status}`} aria-hidden="true">{repairing ? '↻' : statusBadge[status]}</span>}</span>;
}
function MemberRow({ m, now }: { m: BoardMember; now: number }) {
  void now;
  return <div class="member" data-member={m.id} data-status={m.status}>
    <Avatar role={m.role} status={m.status} repairing={m.repairing} />
    <div style={{ minWidth: 0 }}>
      <div class="name wrap-anywhere">{m.name}</div>
      {m.lines.map((l, i) => <div key={i} class="what wrap-anywhere">{l}</div>)}
      <span class="sr-only">, {statusLabel[m.status]}</span>
    </div>
  </div>;
}
/** A folded group: overlapping avatars, the count and a Show/Hide toggle. Open state is kept per task and group in this browser only. */
function Stack({ taskId, group, status, rows, now, render }: { taskId: string; group: string; status: BoardStatus; rows: BoardMember[]; now: number; render: (m: BoardMember) => ComponentChildren }) {
  const key = `devagents.team-board.${taskId}.${group}.${status}`;
  const [open, setOpen] = useState<boolean>(() => { try { return localStorage.getItem(key) === '1'; } catch { return false; } });
  const toggle = () => { setOpen(o => { try { localStorage.setItem(key, o ? '0' : '1'); } catch { /* per-viewer convenience only */ } return !o; }); };
  const items = rows.reduce((n, m) => n + m.items.length, 0);
  const label = `${statusBadge[status]} ${rows.length} ${statusLabel[status]}${items && status !== 'off' ? ` · ${items} item${items === 1 ? '' : 's'}` : ''}`;
  const tone = status === 'done' ? 'ok' : 'neutral';
  return <div class="stackgroup" data-stack={status}>
    <button type="button" class={`stackbtn ${open ? 'open' : ''}`} aria-expanded={open} onClick={toggle}>
      {!open && <span class="facepile" aria-hidden="true">{rows.slice(0, 5).map(m => <Avatar key={m.key} role={m.role} status={m.status} size="xs" />)}</span>}
      <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', minWidth: 0 }}><Stage tone={tone}>{label}</Stage>{!open && <span class="what wrap-anywhere">{rows.map(m => m.name).join(', ')}</span>}</span>
      <span class="muted" style={{ marginLeft: 'auto', fontSize: '12px' }}>{open ? 'Hide' : 'Show'}</span>
    </button>
    {open && <div class="stackrows">{rows.map(render)}</div>}
    {void now}
  </div>;
}
function Folded({ taskId, group, rows, now, limit, render }: { taskId: string; group: string; rows: BoardMember[]; now: number; limit?: number; render: (m: BoardMember) => ComponentChildren }) {
  return <>{fold(rows, limit).map((r, i) => r.kind === 'row' ? <span key={r.row.key} style={{ display: 'contents' }}>{render(r.row)}</span> : <Stack key={`stack-${r.status}-${i}`} taskId={taskId} group={group} status={r.status} rows={r.rows} now={now} render={render} />)}</>;
}

export function Pipeline({ board, taskId, now }: { board: TeamBoard; taskId: string; now: number }) {
  const legend: [BoardStatus, string][] = [['done', 'Finished'], ['busy', 'Working now'], ['next', 'Up next'], ['you', 'Needs you']];
  return <section class="card pipeline" aria-label="Your team on this task">
    <div class="pipeline-head">
      <div><b style={{ fontSize: '16px' }}>Your team on this task</b><div class="muted" style={{ fontSize: '13px' }}>{board.summary} · measured from recorded runs, no estimates</div></div>
      <div class="legend" aria-hidden="true">{legend.map(([s, l]) => <span key={s}><i class={`dot ${s}`} /> {l}</span>)}</div>
    </div>
    <ol class={`pipe stages-${board.stages.length}`}>
      {board.stages.map((s, i) => <li key={s.key} class={`stagecol ${s.status === 'busy' || s.status === 'you' ? 'now' : ''}`} data-stage={s.key} aria-label={`Stage ${s.number}: ${s.title}`}>
        {i > 0 && <span class={`link ${board.stages[i - 1]!.status === 'done' ? 'done' : ''}`} aria-hidden="true" />}
        <div class="title"><span class="h">{s.number} · {s.title}</span><Stage tone={s.chip.tone}>{s.chip.text}</Stage></div>
        {s.members.length === 0 && <div class="what">Nobody assigned yet</div>}
        <Folded taskId={taskId} group={s.key} rows={s.members} now={now} render={m => <MemberRow key={m.key} m={m} now={now} />} />
      </li>)}
    </ol>
    {board.notNeeded.length > 0 && <div class="muted" style={{ fontSize: '12.5px' }}>Not needed for this task: {board.notNeeded.map(m => <span key={m.id}><b>{m.name}</b> ({m.reason})</span>).reduce<ComponentChildren[]>((acc, el, i) => (i ? [...acc, ' · ', el] : [el]), [])}.</div>}
  </section>;
}

/** One card per member. The list folds at six full rows while the task is active; a finished task lists everyone. */
export function MemberList({ board, taskId, now, rulesOn, terminal, onActivity }: { board: TeamBoard; taskId: string; now: number; rulesOn: boolean; terminal: boolean; onActivity: (item: string) => void }) {
  const rows = [...board.list, ...board.notNeeded.map(m => ({ ...m, key: `member:${m.id}` }))];
  const card = (m: BoardMember) => <article key={m.key} class={`card mcard ${m.status === 'busy' ? 'now' : m.status === 'you' ? 'need' : m.status === 'fail' ? 'failed' : m.status === 'off' ? 'off' : ''}`} data-member={m.id} data-status={m.status}>
    <div class="member">
      <Avatar role={m.role} status={m.status} repairing={m.repairing} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div class="name wrap-anywhere">{m.name}{m.id !== m.name && m.role !== 'you' && m.role !== 'system' && <span class="mono muted" style={{ fontWeight: 500, marginLeft: '6px' }}>{m.id}</span>}</div>
        {m.items.length === 0 && m.lines.map((l, i) => <div key={i} class="what wrap-anywhere">{l}</div>)}
        {m.items.length > 0 && <div class="what wrap-anywhere">{m.items.map(i => <span key={i.id}><span class="mono">{i.id}</span> · {i.title}{i.ownedPaths.length ? <> · {rulesOn ? 'owns' : 'planned scope'} <span class="mono">{i.ownedPaths.join(', ')}</span></> : null}{i.dependsOn.length ? <> · depends on <span class="mono">{i.dependsOn.join(', ')}</span></> : null}</span>).reduce<ComponentChildren[]>((acc, el, i) => (i ? [...acc, <br key={`br${i}`} />, el] : [el]), [])}</div>}
      </div>
      <Stage tone={m.status === 'done' ? 'ok' : m.status === 'busy' ? 'run' : m.status === 'you' ? 'warn' : m.status === 'fail' ? 'bad' : 'neutral'}>{statusBadge[m.status]} {statusLabel[m.status]}</Stage>
    </div>
    {m.items.map(i => <div key={i.id} class="mcard-item">
      {m.items.length > 1 && <span class="mono muted" style={{ fontSize: '12px' }}>{i.id}</span>}
      <div class="stages">{i.chips.map((c, k) => <Stage key={k} tone={c.tone}>{c.text}</Stage>)}</div>
      <dl class="kv mcard-facts">
        {i.startedAt && <><dt>{i.status === 'busy' ? 'Started' : 'Ran'}</dt><dd>{clock(i.startedAt)}{i.finishedAt ? ` → ${clock(i.finishedAt)}` : i.status === 'busy' ? ` · ${duration(now - new Date(i.startedAt).getTime())} so far` : ''}</dd></>}
        <dt>Validation</dt><dd class="mono wrap-anywhere">{i.validation.join(' ; ') || '—'}</dd>
        <dt>Repairs</dt><dd>{i.repairCycles} used</dd>
        {i.updatedAt && <><dt>Last event</dt><dd>{clock(i.updatedAt)}</dd></>}
      </dl>
      {i.error && <div class="note bad" style={{ fontSize: '12.5px' }}>{i.error}</div>}
      <div><button type="button" class="btn small" onClick={() => onActivity(i.id)}>Show activity for {i.id}</button></div>
    </div>)}
    {m.items.length > 0 && m.lines.length > m.items.length && <div class="what wrap-anywhere">{m.lines.slice(m.items.length === 1 ? 1 : 2).join(' · ')}</div>}
    {m.durationMs !== undefined && m.durationMs > 0 && m.items.length > 0 && <div class="muted" style={{ fontSize: '12.5px' }}>Recorded run time: {duration(m.durationMs)}{m.repairing ? ' · including repairs' : ''}</div>}
  </article>;
  return <section class="memberlist" aria-label="Team members">
    <div class="h">Who is finished, who is working, who is left</div>
    <Folded taskId={taskId} group="list" rows={rows} now={now} limit={terminal ? Number.POSITIVE_INFINITY : 6} render={card} />
  </section>;
}
