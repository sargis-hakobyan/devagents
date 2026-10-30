import { TaskDiff } from '../components/TaskDiff';
import { useTaskActions } from '../components/TaskActions';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, evidenceFacts, type Evidence, type ItemProgress, type Task, type TaskEvent } from '../api';
import { Card, Chip, ErrorNote, ItemChip, Later, Pre, Skeleton, Stage, StateChip, pretty } from '../components/ui';
import { command, elapsed, formatTime, relative, taskState } from '../format';
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
  const perItem = useMemo(() => itemEvidence(evidence.rows), [evidence.rows]);
  useEffect(() => { if (task?.state === 'completed' && tab === 'work' && !task.plan) setTab('result'); }, [task?.state]);
  if (!task && detail.error) return <ErrorNote message={detail.error} />;
  if (!task) return <><Skeleton rows={2} label="Loading task" /><Skeleton rows={4} /></>;
  const state = taskState(task); const terminal = ['completed', 'failed', 'cancelled'].includes(task.state);
  const finishedAt = terminal ? task.updatedAt : undefined;
  const summary = summarize(task, items);
  return <>
    <a href="/ui/tasks" style={{ fontWeight: 700, fontSize: '13.5px', textDecoration: 'none' }}>← All tasks</a>
    <Card>
      <div style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 }}>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}><StateChip task={task} /><span class="muted" style={{ fontSize: '13px' }}>{task.mode ?? 'mode not chosen'} · v{task.version} · started {formatTime(task.createdAt)} · {terminal ? 'took' : 'elapsed'} {elapsed(task.createdAt, finishedAt, now)}</span></div>
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
    {tab === 'work' && <WorkTab task={task} items={items} perItem={perItem} now={now} />}
    {tab === 'plan' && <><div class="note info">Plan · version {task.version}. Approval applies to this version.</div><PlanTab task={task} /><div class="decision-bar">{renderActions()}</div></>}
    {tab === 'activity' && <ActivityTab task={task} events={events.rows} evidence={evidence.rows} />}
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
    case 'completed': return { title: 'Completed: one reviewed local commit on the task branch', tone: 'info', detail: `Commit ${task.outcome?.commit?.slice(0, 7) ?? '—'} on ${task.workspace?.branch ?? 'the task branch'}. Nothing was merged or pushed; you integrate it yourself.` };
    case 'failed': return { title: /Service shutdown interrupted/.test(task.outcome?.error ?? '') ? 'Interrupted by a service shutdown' : 'Stopped: the task failed', tone: 'bad', detail: task.outcome?.error ?? 'See Activity for the last recorded step.' };
    case 'cancelled': return { title: 'Cancelled by you', tone: 'warn', detail: 'Workers were stopped and worktrees preserved. Resubmitting creates a new task.' };
    default: return { title: task.state, tone: 'info', detail: '' };
  }
}
const itemVerb = (s: string) => ({ running: 'implementing', validating: 'validating', reviewing: 'reviewing', repairing: 'repairing', creating: 'preparing a worktree for', checkpointing: 'checkpointing', integrating: 'integrating' } as Record<string, string>)[s] ?? s;

type PerItem = Record<string, { tests?: { exitCode: number; truncated?: boolean }[]; review?: { approved: boolean; findingsCount: number }; commit?: string; implementations: number }>;
function itemEvidence(rows: Evidence[]): PerItem {
  const out: PerItem = {};
  const at = (id: string) => (out[id] ??= { implementations: 0 });
  for (const e of rows) {
    const d = evidenceFacts(e); const id = typeof d.workItemId === 'string' ? d.workItemId : undefined;
    if (e.kind === 'validation' && id) at(id).tests = [...(at(id).tests ?? []), { exitCode: Number(d.exitCode), ...(d.truncated ? { truncated: true } : {}) }];
    if (e.kind === 'run-completed' && id && d.phase === 'review') { const o = d.output as ReviewFacts | undefined; if (o) at(id).review = { approved: reviewPassed(o), findingsCount: findingCount(o) ?? 0 }; }
    if (e.kind === 'run-completed' && id && d.phase === 'implementation') at(id).implementations++;
    if (e.kind === 'item-commit-created' && id && typeof d.commit === 'string') at(id).commit = d.commit;
  }
  return out;
}
function WorkTab({ task, items, perItem, now }: { task: Task; items: ItemProgress[]; perItem: PerItem; now: number }) {
  if (!task.plan) return <Card><div class="empty"><b>No work items yet</b><span>Items appear once the Tech Lead's plan is stored{task.state === 'awaiting_mode' ? ', after a mode is chosen' : ''}.</span></div></Card>;
  const multi = task.plan.items.length > 1; const integrated = items.filter(i => i.state === 'completed').length;
  return <div class="stack">
    <div class="muted" style={{ fontSize: '13px' }}>{multi ? `Measured: ${integrated} of ${items.length} integrated · repairs are bounded per item plus one shared integration budget` : 'Single work item: validation and review run in the task worktree'} · stages can revisit tests, review and implementation during repair.</div>
    <div class="items">{task.plan.items.map(planned => {
      const p = items.find(i => i.itemId === planned.id); const ev = perItem[planned.id] ?? perItem['@integration'];
      const st = p?.state ?? 'pending'; const current = ['running', 'validating', 'reviewing', 'repairing', 'creating', 'checkpointing', 'integrating'].includes(st);
      const lastTest = ev?.tests?.[ev.tests.length - 1]; const testsRan = ev?.tests?.length ?? 0;
      return <article key={planned.id} class={`card item ${current ? 'current' : ''}`}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}><b class="wrap-anywhere"><span class="mono">{planned.id}</span> · {planned.title}</b><ItemChip state={st} /></div>
        <div class="muted" style={{ fontSize: '13px' }}>{planned.assignedAgent ?? 'any eligible agent'}{planned.ownedPaths?.length ? <> · owns <span class="mono">{planned.ownedPaths.join(', ')}</span></> : null}{planned.dependsOn.length ? <> · depends on <span class="mono">{planned.dependsOn.join(', ')}</span></> : ' · no dependencies'}</div>
        <div class="stages">
          <Stage tone={ev?.implementations ? 'ok' : current && st === 'running' ? 'run' : 'neutral'}>Implemented{ev?.implementations ? ` ×${ev.implementations}` : ''}</Stage>
          <Stage tone={!testsRan ? (st === 'validating' ? 'run' : 'neutral') : lastTest && lastTest.exitCode === 0 && !lastTest.truncated ? (testsRan > 1 ? 'warn' : 'ok') : 'bad'}>{!testsRan ? 'Tests' : lastTest!.exitCode === 0 && !lastTest!.truncated ? (testsRan > 1 ? `Tests ✕ then ✓ (${testsRan} runs)` : 'Tests ✓') : lastTest!.truncated ? 'Tests · output truncated' : `Tests ✕ (exit ${lastTest!.exitCode})`}</Stage>
          <Stage tone={!ev?.review ? (st === 'reviewing' ? 'run' : 'neutral') : ev.review.approved && ev.review.findingsCount === 0 ? 'ok' : 'warn'}>{!ev?.review ? 'Review' : ev.review.approved && ev.review.findingsCount === 0 ? 'Review ✓' : `Review · ${ev.review.findingsCount} finding${ev.review.findingsCount === 1 ? '' : 's'}`}</Stage>
          {multi && <Stage tone={ev?.commit || p?.commit ? 'ok' : 'neutral'}>{p?.commit || ev?.commit ? `Checkpoint ${(p?.commit ?? ev?.commit)!.slice(0, 7)}` : 'Checkpoint'}</Stage>}
        </div>
        <div class="muted" style={{ fontSize: '12.5px' }}>Repairs: {p?.repairCycles ?? 0} · validation <span class="mono">{planned.validation.map(command).join(' ; ')}</span>{p?.updatedAt && <> · updated {relative(p.updatedAt, now)}</>}</div>
        {(p?.error || p?.reason) && <div class="note bad" style={{ fontSize: '12.5px' }}>{p.reason ?? ''}{p.reason && p.error ? ' · ' : ''}{p.error ?? ''}</div>}
      </article>;
    })}</div>
    {multi && <Card><div style={{ padding: '12px 14px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}><b>Then</b><Stage tone={['validating', 'reviewing', 'committing', 'completed'].includes(task.state) && integrated === items.length ? 'ok' : 'neutral'}>Combined validation · {new Set([...task.plan.items.flatMap(i => i.validation), ...(task.plan.integration?.validation ?? [])].map(command)).size} commands</Stage><Stage tone={task.state === 'completed' ? 'ok' : task.state === 'reviewing' ? 'run' : 'neutral'}>Independent review</Stage><Stage tone={task.state === 'completed' ? 'ok' : task.state === 'committing' ? 'run' : 'neutral'}>Final local commit</Stage></div></Card>}
  </div>;
}
function PlanTab({ task }: { task: Task }) {
  const plan = task.plan;
  if (!plan) return <Card><div class="empty"><b>No plan yet</b><span>{task.state === 'awaiting_mode' ? 'Planning starts after a mode is chosen.' : task.state === 'planning' ? 'The Tech Lead is planning now.' : 'This task ended before a plan was stored.'}</span></div></Card>;
  return <div class="stack">
    <Card title={<>Plan · {approvalLabel(task)}{task.approval?.timestamp ? ` · ${formatTime(task.approval.timestamp)}` : ''}</>} right={<Chip tone="neutral">saved plan</Chip>}>
      <div style={{ padding: '14px 16px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '16px' }}>
        <div><div class="h">Summary</div><div class="wrap-anywhere">{plan.summary}</div><div class="h" style={{ marginTop: '10px' }}>Risks</div>{plan.risks.length ? <ul class="criteria">{plan.risks.map((r, i) => <li key={i} class="wrap-anywhere">{r}</li>)}</ul> : <div class="muted">None declared by the planner.</div>}</div>
        <div><div class="h">Your acceptance criteria</div>{task.acceptanceCriteria.length ? <ul class="criteria">{task.acceptanceCriteria.map((c, i) => <li key={i} class="wrap-anywhere">{c}</li>)}</ul> : <div class="muted">None given.</div>}
          {plan.integration && <><div class="h" style={{ marginTop: '10px' }}>Integration</div><div>{plan.integration.assignedAgent} · <span class="mono">{plan.integration.validation.map(command).join(' ; ')}</span></div></>}</div>
      </div>
    </Card>
    <div class="items">{plan.items.map(i => <article key={i.id} class="card item">
      <b class="wrap-anywhere"><span class="mono">{i.id}</span> · {i.title}</b>
      <div class="wrap-anywhere" style={{ fontSize: '13.5px' }}>{i.description}</div>
      <dl class="kv" style={{ gridTemplateColumns: '110px minmax(0, 1fr)', fontSize: '13px' }}>
        <dt>Agent</dt><dd>{i.assignedAgent ?? 'any eligible'} · needs {i.requiredCapabilities.join(', ')}</dd>
        <dt>Scope</dt><dd class="mono">{i.ownedPaths?.join(', ') ?? 'agent write scope'}</dd>
        <dt>Depends on</dt><dd class="mono">{i.dependsOn.length ? i.dependsOn.join(', ') : '—'}</dd>
        <dt>Validation</dt><dd class="mono">{i.validation.map(command).join(' ; ')}</dd>
        <dt>Branch</dt><dd class="mono">{i.branch}</dd>
      </dl>
      <div class="h">Acceptance criteria</div><ul class="criteria" style={{ fontSize: '13px' }}>{i.acceptanceCriteria.map((c, k) => <li key={k} class="wrap-anywhere">{c}</li>)}</ul>
    </article>)}</div>
  </div>;
}
function ActivityTab({ task, events, evidence }: { task: Task; events: TaskEvent[]; evidence: Evidence[] }) {
  type Row = { at: string; actor: string; sequence: number; kind: 'event' | 'evidence'; body: string; detail?: unknown; truncated?: boolean; evidenceSequence?: number };
  // Completed and failed runs carry the run id, not the agent; the start entry names the agent.
  const agentByRun = new Map<string, string>();
  for (const e of evidence) { const d = evidenceFacts(e); if (e.kind === 'run-started' && typeof d.runId === 'string' && typeof d.agentId === 'string') agentByRun.set(d.runId, d.agentId); }
  const rows: Row[] = [
    ...events.map(e => ({ at: e.timestamp, actor: e.actor, sequence: e.sequence, kind: 'event' as const, body: `${taskState({ state: e.state, error: '' }).label} · ${e.reason}` })),
    ...evidence.map(e => ({ at: e.at, actor: evidenceActor(e, agentByRun), sequence: e.sequence, kind: 'evidence' as const, body: evidenceTitle(e), detail: e.data, ...(e.truncated ? { truncated: true } : {}), evidenceSequence: e.sequence })),
  ].sort((a, b) => b.at.localeCompare(a.at) || b.sequence - a.sequence);
  const [limit, setLimit] = useState(40);
  return <Card title="Activity" right={<span class="muted" style={{ fontSize: '12.5px' }}>{events.length} events · {evidence.length} evidence entries · newest first · entries bounded to 16 KB</span>}>
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
    case 'validation': return `validation ${typeof d.exitCode !== 'number' ? 'result unavailable' : d.truncated ? 'failed (output truncated)' : d.exitCode === 0 ? 'passed' : `failed (exit ${d.exitCode})`}${d.truncated ? ' · output truncated' : ''}${item} · ${[d.executable, ...((d.args as string[] | undefined) ?? [])].join(' ')}`;
    case 'work-item': return `item ${String(d.itemId)} → ${String(d.state)}`;
    case 'progress': return `engine ${String(d.kind)}${item}`;
    default: return `${e.kind}${item}`;
  }
}
function ResultTab({ task, evidence }: { task: Task; evidence: Evidence[] }) {
  const reviews = evidence.filter(e => e.kind === 'run-completed' && evidenceFacts(e).phase === 'review');
  const last = reviews[reviews.length - 1]; const review = last ? evidenceFacts(last).output as ReviewFacts | undefined : undefined;
  const validations = evidence.filter(e => e.kind === 'validation');
  if (task.state !== 'completed') return <Card tone={task.state === 'failed' ? 'bad' : undefined}><div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
    <b>Result</b><span>Diff inspection is offered for completed tasks only.</span>
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
