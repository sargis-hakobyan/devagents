import { TaskCompaction } from '../components/TaskCompaction';
import { TaskDiff } from '../components/TaskDiff';
import { useTaskActions } from '../components/TaskActions';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { api, evidenceFacts, type Evidence, type ItemProgress, type Task, type TaskEvent } from '../api';
import { Card, Chip, ErrorNote, Later, Pre, Skeleton, Stage, StateChip, pretty } from '../components/ui';
import { MemberList, Pipeline } from '../components/TeamBoard';
import { teamBoard, type TeamBoard } from '../team-board';
import { limitationCount, command, elapsed, formatTime, taskState } from '../format';
import { forget, useNow, usePoll } from '../state';

type Tab = 'work' | 'plan' | 'activity' | 'result';
type Detail = { task: Task; items: ItemProgress[] };

/** Events and evidence are appended by sequence cursor, so polling and reconnects never duplicate or drop rows. */
function useAppendLog<T extends { sequence: number }>(path: string, intervalMs: number, pageSize: number) {
  const [rows, setRows] = useState<T[]>([]); const latest = useRef(0);
  useEffect(() => { setRows([]); latest.current = 0; return () => forget(`log:${path}`); }, [path]);
  const poll = usePoll(`log:${path}`, async () => {
    const next = await api<T[]>(`${path}?after=${latest.current}&limit=${pageSize}`);
    if (next.length) { latest.current = next[next.length - 1]!.sequence; setRows(r => [...r, ...next.filter(n => !r.some(x => x.sequence === n.sequence))]); }
    return next.length;
  }, intervalMs);
  return { rows, ...poll };
}

export function TaskDetailPage({ id }: { id: string }) {
  const now = useNow();
  const [tab, setTab] = useState<Tab>('work');
  useEffect(() => () => forget(`task:${id}`), [id]);
  const detail = usePoll(`task:${id}`, async (): Promise<Detail> => { const [task, items] = await Promise.all([api<Task>(`/tasks/${id}`), api<ItemProgress[]>(`/tasks/${id}/items`)]); return { task, items }; }, 3000);
  const events = useAppendLog<TaskEvent>(`/tasks/${id}/events`, 3000, 500);
  const evidence = useAppendLog<Evidence>(`/tasks/${id}/evidence`, 3000, 200);
  const task = detail.data?.task; const items = detail.data?.items ?? [];
  const renderActions = useTaskActions({ task, reload: detail.reload, showPlan: () => setTab('plan') });
  const [activityItem, setActivityItem] = useState<string | undefined>(undefined);
  const board = useMemo(() => (task ? teamBoard({ task, items, evidence: evidence.rows, now }) : undefined), [task, items, evidence.rows, now]);
  useEffect(() => { if (task?.state === 'completed' && tab === 'work' && !task.plan) setTab('result'); }, [task?.state]);
  if (!task && detail.error) return <ErrorNote message={detail.error} />;
  if (!task) return <><Skeleton rows={2} label="Loading task" /><Skeleton rows={4} /></>;
  const state = taskState(task); const terminal = ['completed', 'failed', 'cancelled'].includes(task.state);
  const finishedAt = terminal ? task.updatedAt : undefined;
  const summary = board?.stages.some(s => s.key === 'qa' && s.status === 'busy')
    ? { title: 'QA verification in progress', tone: 'info', detail: 'The QA engineer is checking required acceptance criteria. Final review and commit follow only after QA passes.' }
    : summarize(task, items);
  return <>
    {terminal && <Card><TaskCompaction key={task.id} task={task} /></Card>}
    <a href="/ui/tasks" style={{ fontWeight: 700, fontSize: '13.5px', textDecoration: 'none' }}>← All tasks</a>
    <Card>
      <div style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 }}>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}><StateChip task={task} /><span class="muted" style={{ fontSize: '13px' }}>{task.mode ?? 'mode not chosen'} · v{task.version} · started {formatTime(task.createdAt)} · {terminal ? 'took' : 'elapsed'} {elapsed(task.createdAt, finishedAt, now)}</span></div>
            <div class="muted" style={{ fontSize: '13px' }}>Extra DevAgents rules: {(task.devagentsRules ?? true) ? 'on' : 'off · engine sandbox'} · frozen at submission</div>
            <h1 style={{ margin: 0, fontSize: '22px', letterSpacing: '-0.02em', lineHeight: 1.3 }} class="wrap-anywhere">{task.request}</h1>
            <div class="muted" style={{ fontSize: '13.5px' }}>Project <span class="mono">{task.projectId}</span> · Team: {task.team ? <><a href={`/ui/teams/${task.team.id}`}><b>{task.team.name}</b></a> revision {task.team.revision} · {task.team.members.filter(m => m.enabled).length} enabled members frozen at submission{task.team.modelPinned ? '' : ' · model: runtime default (not pinned)'}</> : <><b>Legacy agent configuration</b>{task.agents ? ` (${task.agents.length} agents snapshotted at worktree creation)` : ' (snapshotted when the worktree is created)'}</>}{task.workspace && <> · Branch <span class="mono">{task.workspace.branch}</span></>}</div>
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {renderActions()}
          </div>
        </div>
        <div class={`note ${summary.tone}`} style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}><span aria-hidden="true" style={{ fontSize: '16px' }}>{state.icon}</span><div><b>{summary.title}</b><div class="muted" style={{ fontSize: '13.5px' }}>{summary.detail}</div></div></div>
        {task.state === 'failed' && <a href="/ui/settings/setup">Check setup before submitting a new task</a>}
        {task.state === 'awaiting_plan_approval' && <div class="note warn"><b>Approval binds to version {task.version}.</b> If the plan changes before you approve, the page refreshes and asks again. Approving a plan is not permission to push, merge or run destructive commands.</div>}
      </div>
    </Card>
    <div class="tabs" role="tablist" aria-label="Task sections">
      {([['work', `Work · ${items.length}`], ['plan', 'Plan'], ['activity', `Activity · ${events.rows.length + evidence.rows.length}`], ['result', 'Result']] as [Tab, string][]).map(([t, label]) => <button key={t} type="button" role="tab" class="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{label}</button>)}
    </div>
    {tab === 'work' && board && <WorkTab task={task} board={board} now={now} onActivity={item => { setActivityItem(item); setTab('activity'); }} />}
    {tab === 'plan' && <><PlanTab task={task} />{task.state === 'awaiting_plan_approval' && <div class="decision-bar">{renderActions()}</div>}</>}
    {tab === 'activity' && <ActivityTab task={task} events={events.rows} evidence={evidence.rows} filter={activityItem} onClear={() => setActivityItem(undefined)} />}
    {tab === 'result' && <ResultTab task={task} evidence={evidence.rows} />}
  </>;
}

function summarize(task: Task, items: ItemProgress[]): { title: string; detail: string; tone: 'warn' | 'bad' | 'info' } {
  const current = items.find(i => ['running', 'validating', 'reviewing', 'repairing', 'creating', 'checkpointing', 'integrating'].includes(i.state));
  const done = items.filter(i => i.state === 'completed').length;
  switch (task.state) {
    case 'awaiting_mode': return { title: 'Waiting for you: choose autonomous or plan-approval', tone: 'warn', detail: 'Nothing runs until a mode is chosen. The choice is asked exactly once for this task.' };
    case 'awaiting_plan_approval': return { title: `Waiting for you: approve plan version ${task.version} or reject it`, tone: 'warn', detail: 'Nothing runs until you decide. The plan tab shows the deliverables, scope, risks and validation commands.' };
    case 'planning': return { title: 'The Tech Lead is planning', tone: 'info', detail: 'It inspects the project in a read-only sandbox and proposes a DAG of work items.' };
    case 'ready': return { title: 'Queued', tone: 'info', detail: 'One top-level request runs at a time; this one starts when the scheduler is free.' };
    case 'running': case 'validating': case 'reviewing': case 'repairing': return { title: current ? `Now: ${itemVerb(current.state)} work item ${current.itemId}${current.agentId ? ` (${current.agentId})` : ''}` : `Now: ${task.state}`, tone: 'info', detail: items.length > 1 ? `${done} of ${items.length} items integrated. After every item is integrated, the combined result is validated and reviewed before one local commit. No merge, push or deployment happens.` : 'Implementation, real validation and an independent review precede one local commit on the task branch. No merge, push or deployment happens.' };
    case 'committing': return { title: 'Creating the reviewed local commit', tone: 'info', detail: 'This boundary cannot be cancelled; the outcome appears in Result.' };
    case 'completed': { const n = limitationCount(task.outcome); return { title: n ? `Completed with ${task.outcome?.limitationOverflow ? 'at least ' : ''}${n} check${n === 1 ? '' : 's'} not run in this environment` : 'Completed: one reviewed local commit on the task branch', tone: n ? 'warn' : 'info', detail: `Commit ${task.outcome?.commit?.slice(0, 7) ?? '—'} on ${task.workspace?.branch ?? 'the task branch'}. Nothing was merged or pushed; you integrate it yourself.${n ? ' The Result tab lists what you should verify yourself.' : ''}` }; }
    case 'failed': if (task.outcome?.error?.startsWith('QA could not verify required acceptance criteria.')) return { title: 'Implementation complete; verification stopped at QA', tone: 'warn', detail: 'The developer finished and project validation passed. QA could not verify some checks in its environment, so this earlier run stopped before review and commit. See Activity for the original evidence.' }; return { title: /Service shutdown interrupted/.test(task.outcome?.error ?? '') ? 'Interrupted by a service shutdown' : 'Stopped: the task failed', tone: 'bad', detail: task.outcome?.error ?? 'See Activity for the last recorded step.' };
    case 'cancelled': return { title: 'Cancelled by you', tone: 'warn', detail: 'Workers were stopped and worktrees preserved. Resubmitting creates a new task.' };
    default: return { title: task.state, tone: 'info', detail: '' };
  }
}
const itemVerb = (s: string) => ({ running: 'implementing', validating: 'validating', reviewing: 'reviewing', repairing: 'repairing', creating: 'preparing a worktree for', checkpointing: 'checkpointing', integrating: 'integrating' } as Record<string, string>)[s] ?? s;

/** Pipeline overview followed by stage-ordered execution details, derived from recorded runs. */
function WorkTab({ task, board, now, onActivity }: { task: Task; board: TeamBoard; now: number; onActivity: (item: string) => void }) {
  return <div class="stack">
    <Pipeline board={board} taskId={task.id} now={now} />
    {task.plan ? <MemberList board={board} taskId={task.id} now={now} rulesOn={task.devagentsRules ?? true} terminal={['completed', 'failed', 'cancelled'].includes(task.state)} onActivity={onActivity} /> : <Card><div class="empty"><b>No work items yet</b><span>Members get their work once the Tech Lead's plan is stored{task.state === 'awaiting_mode' ? ', after a mode is chosen' : ''}.</span></div></Card>}
  </div>;
}
function PlanTab({ task }: { task: Task }) {
  const plan = task.plan;
  if (!plan) return <Card><div class="empty"><b>No plan yet</b><span>{task.state === 'awaiting_mode' ? 'Planning starts after a mode is chosen.' : task.state === 'planning' ? 'The Tech Lead is planning now.' : 'This task ended before a plan was stored.'}</span></div></Card>;
  const awaiting = task.state === 'awaiting_plan_approval';
  const agents = [...new Set(plan.items.map(i => i.assignedAgent ?? 'any eligible agent'))];
  const commands = new Set([...plan.items.flatMap(i => i.validation), ...(plan.integration?.validation ?? [])].map(command)).size;
  const section = (title: string, body: ComponentChildren, note?: string) => <section class="plan-section"><div class="h">{title}</div>{body}{note && <div class="muted plan-note">{note}</div>}</section>;
  const list = (rows: string[], size?: string) => <ul class="criteria" style={size ? { fontSize: size } : undefined}>{rows.map((r, i) => <li key={i} class="wrap-anywhere">{r}</li>)}</ul>;
  return <div class="stack plan">
    <Card title={<>Plan · {approvalLabel(task)}{task.approval?.timestamp ? ` · ${formatTime(task.approval.timestamp)}` : ''}</>} right={awaiting ? undefined : <Chip tone="neutral">version {task.version}</Chip>}>
      <div class="plan-summary">
        <p class="plan-lead wrap-anywhere">{plan.summary}</p>
        <div class="plan-facts">
          <Chip tone="neutral">{plan.items.length} work item{plan.items.length === 1 ? '' : 's'}</Chip>
          <Chip tone="neutral">{agents.join(', ')}</Chip>
          <Chip tone="neutral">{commands} validation command{commands === 1 ? '' : 's'}</Chip>
          {task.workspace && <Chip tone="neutral" title="Branch in your repository"><span class="mono">{task.workspace.branch}</span></Chip>}
        </div>
      </div>
      <div class="plan-grid">
        {section('Risks', plan.risks.length ? list(plan.risks) : <div class="muted">None declared by the planner.</div>)}
        {plan.manualChecks?.length ? section('Manual checks for you', list(plan.manualChecks), 'These need tools the sandbox does not provide. They are reported with the result and never enforced by repair.') : null}
        {task.acceptanceCriteria.length ? section('Your acceptance criteria', list(task.acceptanceCriteria)) : null}
        {plan.integration && section('Integration', <div class="wrap-anywhere">{plan.integration.assignedAgent} · <span class="mono">{plan.integration.validation.map(command).join(' ; ')}</span></div>)}
      </div>
    </Card>
    <div class="h plan-items-head">Work items · {plan.items.length}</div>
    <ol class="plan-items">{plan.items.map((i, n) => <li key={i.id}><article class="card item plan-item">
      <header class="plan-item-head">
        <span class="plan-item-n" aria-hidden="true">{n + 1}</span>
        <div class="plan-item-title"><b class="wrap-anywhere">{i.title}</b><span class="mono muted">{i.id}</span></div>
        <Chip tone="neutral">{i.assignedAgent ?? 'any eligible agent'}</Chip>
      </header>
      <p class="plan-item-text wrap-anywhere">{i.description}</p>
      <div class="plan-item-body">
        {section('Done when', list(i.acceptanceCriteria, '13.5px'))}
        <dl class="kv plan-item-facts">
          <dt>Needs</dt><dd>{i.requiredCapabilities.join(', ')}</dd>
          <dt>{(task.devagentsRules ?? true) ? 'Scope' : 'Planned scope (advisory)'}</dt><dd class="mono wrap-anywhere">{i.ownedPaths?.join(', ') ?? 'agent write scope'}</dd>
          <dt>Depends on</dt><dd class="mono">{i.dependsOn.length ? i.dependsOn.join(', ') : '—'}</dd>
          <dt>Validation</dt><dd class="mono wrap-anywhere">{i.validation.map(command).join(' ; ')}</dd>
          <dt>Branch</dt><dd class="mono wrap-anywhere">{i.branch}</dd>
        </dl>
      </div>
    </article></li>)}</ol>
  </div>;
}
function ActivityTab({ task, events, evidence, filter, onClear }: { task: Task; events: TaskEvent[]; evidence: Evidence[]; filter?: string | undefined; onClear?: () => void }) {
  type Row = { at: string; actor: string; sequence: number; kind: 'event' | 'evidence'; body: string; detail?: unknown; truncated?: boolean; evidenceSequence?: number };
  // Completed and failed runs carry the run id, not the agent; the start entry names the agent.
  const agentByRun = new Map<string, string>();
  for (const e of evidence) { const d = evidenceFacts(e); if (e.kind === 'run-started' && typeof d.runId === 'string' && typeof d.agentId === 'string') agentByRun.set(d.runId, d.agentId); }
  // "Show activity for <item>" from the Work tab: evidence recorded for that item, and events whose reason names it.
  const mentions = filter ? new RegExp(`(^|[^A-Za-z0-9_-])${filter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9_-])`) : undefined;
  // A single-item task runs without the DAG, so its runs and validations carry no item id and belong to the only item.
  const single = task.plan?.items.length === 1 && task.plan.items[0]?.id === filter;
  const forItem = (e: Evidence) => { const d = evidenceFacts(e); return d.workItemId === filter || d.itemId === filter || (single && d.workItemId === undefined && d.itemId === undefined && !['commit-intent', 'commit-created', 'worktree-intent', 'environment'].includes(e.kind)); };
  const rows: Row[] = [
    ...events.filter(e => !mentions || mentions.test(e.reason)).map(e => ({ at: e.timestamp, actor: e.actor, sequence: e.sequence, kind: 'event' as const, body: `${taskState({ state: e.state, error: '' }).label} · ${e.reason}` })),
    ...evidence.filter(e => !filter || forItem(e)).map(e => ({ at: e.at, actor: evidenceActor(e, agentByRun), sequence: e.sequence, kind: 'evidence' as const, body: evidenceTitle(e), detail: e.data, ...(e.truncated ? { truncated: true } : {}), evidenceSequence: e.sequence })),
  ].sort((a, b) => b.at.localeCompare(a.at) || b.sequence - a.sequence);
  const [limit, setLimit] = useState(40);
  return <Card title={filter ? <>Activity · item <span class="mono">{filter}</span> <button type="button" class="btn small" style={{ marginLeft: '8px' }} onClick={onClear}>Show all</button></> : 'Activity'} right={<span class="muted" style={{ fontSize: '12.5px' }}>{filter ? `${rows.length} entries for this item · ` : ''}{events.length} events · {evidence.length} evidence entries · newest first · entries bounded to 16 KB</span>}>
    {rows.length === 0 ? <div class="empty"><b>No activity recorded</b></div> : <ol class="timeline" style={{ padding: '4px 14px' }}>{rows.slice(0, limit).map(r => <li key={`${r.kind}-${r.sequence}`}>
      <span class="mono muted">{formatTime(r.at)}</span><span class="muted" style={{ fontSize: '13px' }}>{r.actor}</span>
      {r.detail === undefined ? <span class="wrap-anywhere">{r.body}</span> : <EvidenceRow taskId={task.id} row={r} />}
    </li>)}</ol>}
    {rows.length > limit && <div style={{ padding: '8px 14px', borderTop: '1px solid var(--row)' }}><button type="button" class="btn small" onClick={() => setLimit(l => l + 40)}>Show {Math.min(40, rows.length - limit)} older</button></div>}
  </Card>;
}
function EvidenceRow({ taskId, row }: { taskId: string; row: { body: string; detail?: unknown; truncated?: boolean | undefined; evidenceSequence?: number | undefined } }) {
  const [full, setFull] = useState<unknown>(undefined); const [busy, setBusy] = useState(false);
  const data = full ?? row.detail; const preview = (row.detail as { preview?: string; bytes?: number } | null) ?? null;
  return <details><summary class="wrap-anywhere">{row.body}{row.truncated && !full ? ` · preview of ${preview?.bytes ?? '?'} bytes` : ''}</summary>
    <Pre text={full !== undefined ? pretty(full) : row.truncated && preview?.preview !== undefined ? preview.preview : pretty(data)} />
    {row.truncated && !full && <button type="button" class="btn small" disabled={busy} style={{ marginTop: '6px' }} onClick={() => { setBusy(true); api<Evidence>(`/tasks/${taskId}/evidence/${row.evidenceSequence}`).then(e => setFull(e.data)).catch(() => setFull('Could not load the full entry.')).finally(() => setBusy(false)); }}>Load full entry (up to 1 MiB)</button>}
  </details>;
}
function evidenceActor(e: Evidence, agentByRun: Map<string, string>): string {
  const d = evidenceFacts(e);
  if (typeof d.agentId === 'string') return d.agentId;
  if (typeof d.runId === 'string' && agentByRun.has(d.runId)) return agentByRun.get(d.runId)!;
  return e.kind.startsWith('run-') || e.kind === 'progress' ? 'engine' : 'orchestrator';
}
function evidenceTitle(e: Evidence): string {
  const d = evidenceFacts(e); const item = typeof d.workItemId === 'string' ? ` · item ${d.workItemId}` : typeof d.itemId === 'string' ? ` · item ${d.itemId}` : '';
  switch (e.kind) {
    case 'run-started': return `${d.phase} run started${item}`;
    case 'run-completed': return `${d.phase} run completed${item}${d.phase === 'review' ? ` · ${reviewPassed(d.output as ReviewFacts | undefined) ? 'approved' : 'changes requested'}` : ''}`;
    case 'run-failed': return `${d.phase} run failed${item}`;
    case 'qa-assignment': return d.state === 'assigned' ? `QA assigned to ${d.agentId}` : `QA skipped · ${d.reason}`;
    case 'qa-result': return `QA ${d.state} · ${d.summary}`;
    case 'validation': return `validation ${typeof d.exitCode !== 'number' ? 'result unavailable' : d.truncated ? 'failed (output truncated)' : d.exitCode === 0 ? 'passed' : `failed (exit ${d.exitCode})`}${d.truncated ? ' · output truncated' : ''}${item} · ${[d.executable, ...((d.args as string[] | undefined) ?? [])].join(' ')}`;
    case 'work-item': return `item ${String(d.itemId)} → ${String(d.state)}`;
    case 'progress': return `engine ${String(d.kind)}${item}`;
    default: return `${e.kind}${item}`;
  }
}
function LimitationReports({ outcome }: { outcome: Task['outcome'] }) {
  return <>
    {outcome?.limitations?.length ? <ul class="criteria" aria-label="Checks not run in this environment">{outcome.limitations.map((l, i) => <li key={i} class="wrap-anywhere">{l}</li>)}</ul> : <span class="muted">No limitations recorded</span>}
    {!!outcome?.limitationsOmitted && <p class="muted">{outcome.limitationsOmitted} further distinct reports are omitted from this list; see Activity for the evidence.</p>}
    {!!outcome?.limitationOverflow && <p class="muted">{outcome.limitationOverflow} additional report occurrences have no retained distinct identities. The total is a lower bound; see Activity for every report.</p>}
  </>;
}
function ResultTab({ task, evidence }: { task: Task; evidence: Evidence[] }) {
  const reviews = evidence.filter(e => e.kind === 'run-completed' && evidenceFacts(e).phase === 'review');
  const last = reviews[reviews.length - 1]; const review = last ? evidenceFacts(last).output as ReviewFacts | undefined : undefined;
  const validations = evidence.filter(e => e.kind === 'validation');
  const qaEntry = evidence.filter(e => e.kind === 'qa-result').at(-1);
  const qa = qaEntry ? evidenceFacts(qaEntry) : undefined;
  const assignment = evidence.filter(e => e.kind === 'qa-assignment').at(-1);
  const skipped = assignment ? evidenceFacts(assignment) : undefined;
  const qaSummary = qa ? `${qa.state} · ${qa.summary}` : skipped?.state === 'skipped' ? String(skipped.reason ?? 'QA skipped') : 'No QA verification recorded';
  if (task.state !== 'completed') return <Card tone={task.state === 'failed' ? 'bad' : undefined}><div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
    <b>Result</b><span>Diff inspection is offered for completed tasks only.</span><div class="wrap-anywhere"><b>Quality assurance</b> · {qaSummary}</div><div><b>Not verified here</b><LimitationReports outcome={task.outcome} /></div>
    {task.state === 'failed' || task.state === 'cancelled' ? <><div class="wrap-anywhere">{task.outcome?.error ?? 'No commit was created.'}</div><div class="muted" style={{ fontSize: '13px' }}>Worktrees are preserved for inspection{task.workspace ? <> under <span class="mono">{task.workspace.path}</span></> : null}. Resubmitting creates a new task. Cleanup is a separate, previewed action.</div><div style={{ display: 'flex', gap: '8px' }}><a class="btn" href={`/ui/tasks/new?from=${task.id}`}>Submit a new task from this request</a><Later label="Clean up worktrees" increment="U3" reason="Cleanup with a preview arrives in U3. CLI: devagents tasks cleanup" /></div></> : <div class="muted">Not available yet. Completion means one reviewed local commit{task.workspace ? <> on <span class="mono">{task.workspace.branch}</span></> : null}; you merge it yourself. Changed files, test evidence and the review outcome appear here afterwards.</div>}
  </div></Card>;
  return <div class="stack">
    <Card title="Result · completed"><div style={{ padding: '14px 16px' }}><dl class="kv">
      <dt>Summary</dt><dd class="wrap-anywhere">{task.outcome?.summary ?? '—'}</dd>
      <dt>Commit</dt><dd class="mono">{task.outcome?.commit ?? '—'} on {task.workspace?.branch ?? '—'}</dd>
      <dt>Changed files</dt><dd>{task.outcome?.files?.length ? <ul class="criteria mono">{task.outcome.files.map(f => <li key={f} class="wrap-anywhere">{f}</li>)}</ul> : '—'}</dd>
      <dt>Repairs used</dt><dd>{task.outcome?.repairCycles ?? 0}</dd>
      <dt>Tests</dt><dd>{validations.length ? `${validations.filter(v => evidenceFacts(v).exitCode === 0 && !evidenceFacts(v).truncated).length} of ${validations.length} validation runs passed; see Activity for output` : 'none recorded'}</dd>
      <dt>Review</dt><dd class="wrap-anywhere">{review ? `${reviewPassed(review) ? 'Approved' : 'Changes requested'} · ${review.summary ?? ''}` : '—'}</dd>
      <dt>Quality assurance</dt><dd class="wrap-anywhere">{qaSummary}{qa && ' · See Activity for criterion-by-criterion evidence'}</dd>
      <dt>Not verified here</dt><dd><LimitationReports outcome={task.outcome} /></dd>
      <dt>Diff</dt><dd>Read the recorded base-to-final change below.</dd>
      <dt>Worktree</dt><dd class="mono wrap-anywhere">{task.workspace?.path ?? '—'}</dd>
    </dl></div>
    <div class="card-foot">Completion is a local reviewed commit, not a merge or deployment. The original checkout was not modified.</div></Card>
    <TaskDiff id={task.id} />
  </div>;
}


type ReviewFacts = { approved?: boolean; summary?: string; findings?: string[]; findingsCount?: number };
function findingCount(review: ReviewFacts): number | undefined { return review.findingsCount ?? review.findings?.length; }
function reviewPassed(review: ReviewFacts | undefined): boolean { return review?.approved === true && findingCount(review) === 0; }
function approvalLabel(task: Task): string {
  switch (task.approval?.status) {
    case 'approved': return 'approved by you';
    case 'autonomous': return 'autonomous mode (no user approval required)';
    case 'awaiting': return `awaiting your approval · version ${task.version}`;
    case 'not-approved': return 'not approved';
    default: return 'approval history unavailable';
  }
}
