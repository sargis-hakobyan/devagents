/**
 * The Work tab's team board, derived from what the task page already loads: the task (plan, roster
 * snapshot, approval, outcome), the work-item progress rows and the evidence log. Pure and import-free so
 * the Node unit suite can exercise every state; the components only render what this returns. Every
 * value is a recorded run, event or checkpoint; durations are differences of recorded timestamps.
 */
export type BoardStatus = 'done' | 'busy' | 'next' | 'you' | 'fail' | 'aborted' | 'off';
export type BoardRole = 'lead' | 'developer' | 'reviewer' | 'qa' | 'you' | 'system' | 'other';
export type Tone = 'ok' | 'run' | 'warn' | 'bad' | 'neutral';
export type StageKey = 'plan' | 'build' | 'review' | 'integrate' | 'commit';
export type StageChip = { tone: Tone; text: string };
export type BoardItem = {
  id: string; title: string; state: string; status: BoardStatus; verb: string; repairCycles: number; chips: StageChip[];
  validation: string[]; ownedPaths: string[]; dependsOn: string[]; startedAt?: string; finishedAt?: string; updatedAt?: string; error?: string;
};
export type BoardMember = {
  key: string; id: string; name: string; role: BoardRole; status: BoardStatus; repairing: boolean; lines: string[]; items: BoardItem[];
  stage: StageKey; reason?: string; durationMs?: number; startedAt?: string; finishedAt?: string;
};
export type BoardStage = { key: StageKey; number: number; title: string; chip: StageChip; status: BoardStatus; members: BoardMember[] };
export type Counts = { involved: number; roster: number; finished: number; working: number; next: number; needsYou: number; failed: number; aborted: number };
export type TeamBoard = { stages: BoardStage[]; list: BoardMember[]; notNeeded: BoardMember[]; counts: Counts; summary: string; multi: boolean };

type Command = { executable: string; args: string[] };
type RosterAgent = { id: string; name: string; capabilities: string[]; enabled: boolean; delegation?: { canDelegate: boolean } };
export type BoardInput = {
  task: {
    id: string; state: string; version: number; createdAt: string; updatedAt: string;
    approval?: { status: string; timestamp?: string } | undefined;
    plan?: { items: { id: string; title: string; assignedAgent?: string | undefined; requiredCapabilities: string[]; validation: Command[]; ownedPaths?: string[] | undefined; dependsOn: string[] }[]; integration?: { assignedAgent: string; validation: Command[] } | null | undefined } | undefined;
    agents?: RosterAgent[] | undefined; team?: { members: RosterAgent[] } | undefined;
    outcome?: { commit?: string | undefined; error?: string | undefined; repairCycles?: number | undefined } | undefined; workspace?: { branch: string } | undefined;
  };
  items: { itemId: string; state: string; agentId?: string | undefined; repairCycles?: number | undefined; commit?: string | undefined; updatedAt?: string | undefined; error?: string | undefined; reason?: string | undefined }[];
  evidence: { kind: string; at: string; data?: unknown; metadata?: Record<string, unknown> | undefined; truncated?: boolean | undefined }[];
  now: number;
};

const BUSY = new Set(['creating', 'running', 'validating', 'reviewing', 'repairing', 'checkpointing', 'integrating']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const VERBS: Record<string, string> = { pending: 'waiting', draft: 'waiting', awaiting_mode: 'waiting for the mode choice', awaiting_plan_approval: 'waiting for your approval', planning: 'being planned', ready: 'queued', committing: 'committing', creating: 'preparing a worktree', running: 'implementing', validating: 'validating', reviewing: 'in review', repairing: 'repairing', checkpointing: 'checkpointing', integrating: 'integrating', reviewed: 'reviewed', completed: 'integrated', failed: 'failed', aborted: 'aborted', interrupted: 'interrupted', cancelled: 'cancelled', blocked: 'blocked' };
const RANK: Record<BoardStatus, number> = { you: 0, fail: 1, busy: 2, aborted: 3, next: 4, done: 5, off: 6 };
const FOLD_LIMIT = 4;

const facts = (e: BoardInput['evidence'][number]): Record<string, unknown> => (e.truncated ? e.metadata ?? {} : (e.data ?? {})) as Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export function duration(ms: number): string {
  if (!(ms >= 0)) return '—';
  const s = Math.floor(ms / 1000); if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60); if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60); return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}
export function clock(iso: string | undefined): string {
  if (!iso) return '—'; const d = new Date(iso); if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
const short = (sha: string | undefined) => (sha ? sha.slice(0, 7) : '—');
const command = (c: Command) => [c.executable, ...c.args].join(' ');
export function itemStatus(state: string): BoardStatus {
  if (BUSY.has(state)) return 'busy';
  if (state === 'reviewed' || state === 'completed' || state === 'committing') return 'done';
  if (state === 'failed') return 'fail';
  if (state === 'aborted' || state === 'interrupted') return 'aborted';
  if (state === 'cancelled' || state === 'blocked') return 'off';
  return 'next';
}
function roleOf(agent: RosterAgent | undefined): BoardRole {
  const c = agent?.capabilities ?? [];
  if (c.includes('planning')) return 'lead';
  if (c.includes('review') && !c.includes('implementation')) return 'reviewer';
  if (c.includes('implementation')) return 'developer';
  if (c.includes('testing')) return 'qa';
  return 'other';
}

type Run = { runId: string; phase: string; agentId: string; workItemId?: string; startedAt: string; endedAt?: string; failed?: boolean; output?: Record<string, unknown> };
type ItemFacts = { tests: { exitCode: number; truncated: boolean }[]; review?: { approved: boolean; findings: number }; implementations: number; commit?: string; startedAt?: string; finishedAt?: string };
function reviewOf(output: unknown): { approved: boolean; findings: number } | undefined {
  if (!output || typeof output !== 'object') return undefined;
  const o = output as { approved?: unknown; findings?: unknown; findingsCount?: unknown };
  const findings = typeof o.findingsCount === 'number' ? o.findingsCount : Array.isArray(o.findings) ? o.findings.length : 0;
  return { approved: o.approved === true && findings === 0, findings };
}

/** Derives the whole board. `now` is a timestamp in milliseconds for the elapsed time of open runs. */
export function teamBoard(input: BoardInput): TeamBoard {
  const { task, now } = input; const plan = task.plan;
  const roster: RosterAgent[] = (task.agents ?? task.team?.members ?? []).filter(a => a.enabled !== false);
  const agent = (id: string | undefined) => roster.find(a => a.id === id);
  const nameOf = (id: string | undefined) => (id ? agent(id)?.name ?? id : 'Any eligible agent');
  const multi = (plan?.items.length ?? 0) > 1;
  const terminal = TERMINAL.has(task.state);

  // Runs and per-item facts from the evidence log.
  const runs = new Map<string, Run>(); const perItem = new Map<string, ItemFacts>(); let commitAt: string | undefined;
  const itemFacts = (id: string) => { let f = perItem.get(id); if (!f) { f = { tests: [], implementations: 0 }; perItem.set(id, f); } return f; };
  // A single-item task runs without the DAG: its runs and validations carry no item id and belong to the only item.
  const onlyItem = !multi ? plan?.items[0]?.id : undefined;
  input.evidence.forEach((e, index) => {
    const d = facts(e); const runId = str(d.runId) ?? (e.kind === 'run-completed' || e.kind === 'run-failed' ? `unrecorded:${index}` : undefined); const item = str(d.workItemId) ?? str(d.itemId) ?? (e.kind === 'work-item' ? undefined : onlyItem);
    if (e.kind === 'run-started' && runId) runs.set(runId, { runId, phase: str(d.phase) ?? '', agentId: str(d.agentId) ?? '', ...(item ? { workItemId: item } : {}), startedAt: e.at });
    if ((e.kind === 'run-completed' || e.kind === 'run-failed') && runId) {
      const r = runs.get(runId) ?? { runId, phase: str(d.phase) ?? '', agentId: '', ...(item ? { workItemId: item } : {}), startedAt: e.at }; runs.set(runId, r);
      r.endedAt = e.at; if (e.kind === 'run-failed') r.failed = true; else if (d.output && typeof d.output === 'object') r.output = d.output as Record<string, unknown>;
      if (e.kind === 'run-completed' && item && r.phase === 'implementation') itemFacts(item).implementations++;
      if (e.kind === 'run-completed' && item && r.phase === 'review') { const rv = reviewOf(d.output); if (rv) itemFacts(item).review = rv; }
    }
    if (e.kind === 'validation' && item) itemFacts(item).tests.push({ exitCode: Number(d.exitCode), truncated: d.truncated === true });
    if (e.kind === 'item-commit-created' && item) { const c = str(d.commit); if (c) itemFacts(item).commit = c; }
    if (e.kind === 'commit-created') commitAt = e.at;
    if (e.kind === 'work-item' && item) { const f = itemFacts(item); const s = str(d.state) ?? ''; if (s !== 'pending' && !f.startedAt) f.startedAt = e.at; if (itemStatus(s) !== 'busy' && itemStatus(s) !== 'next') f.finishedAt = e.at; else delete f.finishedAt; }
  });
  const runList = [...runs.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const runMs = (r: Run) => new Date(r.endedAt ?? new Date(now).toISOString()).getTime() - new Date(r.startedAt).getTime();
  const sumRuns = (rs: Run[]) => rs.reduce((t, r) => t + Math.max(0, runMs(r)), 0);
  const member = (p: Partial<BoardMember> & { id: string; stage: StageKey; status: BoardStatus }): BoardMember => ({ key: `${p.stage}:${p.id}`, name: nameOf(p.id), role: roleOf(agent(p.id)), repairing: false, lines: [], items: [], ...p });

  // Items: the progress rows, or one synthesized row for a single-item task that runs without the DAG.
  const progress = new Map(input.items.map(i => [i.itemId, i]));
  const implementationRuns = runList.filter(r => r.phase === 'implementation' && r.workItemId !== '@integration');
  const synthesized = (): string => ({ running: 'running', validating: 'validating', reviewing: 'reviewing', repairing: 'repairing', committing: 'completed', completed: 'completed', failed: 'failed', cancelled: 'cancelled' } as Record<string, string>)[task.state] ?? 'pending';
  const items: (BoardItem & { agentId: string | undefined })[] = (plan?.items ?? []).map(planned => {
    const p = progress.get(planned.id); const f = perItem.get(planned.id);
    const state = p?.state ?? (!multi ? synthesized() : 'pending'); const status = itemStatus(state);
    const lastTest = f?.tests[f.tests.length - 1]; const ran = f?.tests.length ?? 0;
    const chips: StageChip[] = [
      { tone: f?.implementations ? 'ok' : state === 'running' ? 'run' : 'neutral', text: `Implemented${(f?.implementations ?? 0) > 1 ? ` ×${f!.implementations}` : ''}` },
      { tone: !ran ? (state === 'validating' ? 'run' : 'neutral') : lastTest!.exitCode === 0 && !lastTest!.truncated ? (ran > 1 ? 'warn' : 'ok') : 'bad', text: !ran ? (state === 'validating' ? 'Tests running' : 'Tests') : lastTest!.exitCode === 0 && !lastTest!.truncated ? (ran > 1 ? `Tests ✕ then ✓ (${ran} runs)` : 'Tests ✓') : lastTest!.truncated ? 'Tests · output truncated' : `Tests ✕ (exit ${lastTest!.exitCode})` },
      { tone: !f?.review ? (state === 'reviewing' ? 'run' : 'neutral') : f.review.approved ? 'ok' : 'warn', text: !f?.review ? 'Review' : f.review.approved ? 'Review ✓' : `Review · ${plural(f.review.findings, 'finding')}` },
      ...(multi ? [{ tone: (p?.commit ?? f?.commit) ? 'ok' : 'neutral', text: (p?.commit ?? f?.commit) ? `Checkpoint ${short(p?.commit ?? f?.commit)}` : 'Checkpoint' } as StageChip, { tone: state === 'completed' ? 'ok' : 'neutral', text: state === 'completed' ? 'Integrated' : 'Integration' } as StageChip] : []),
    ];
    const runsFor = implementationRuns.filter(r => r.workItemId === planned.id || (!multi && !r.workItemId));
    const agentId = p?.agentId ?? runsFor[0]?.agentId ?? planned.assignedAgent;
    return {
      id: planned.id, title: planned.title, state, status, verb: VERBS[state] ?? state, repairCycles: p?.repairCycles ?? (!multi ? task.outcome?.repairCycles ?? 0 : 0), chips, agentId,
      validation: planned.validation.map(command), ownedPaths: planned.ownedPaths ?? [], dependsOn: planned.dependsOn,
      ...(f?.startedAt ?? runsFor[0]?.startedAt ? { startedAt: f?.startedAt ?? runsFor[0]!.startedAt } : {}), ...(f?.finishedAt ? { finishedAt: f.finishedAt } : {}), ...(p?.updatedAt ? { updatedAt: p.updatedAt } : {}),
      ...(p?.error || p?.reason ? { error: [p.reason, p.error].filter(Boolean).join(' · ') } : !multi && status === 'fail' && task.outcome?.error ? { error: task.outcome.error } : {}),
    };
  });
  const itemLine = (i: BoardItem, verbose: boolean): string => {
    const open = i.startedAt && i.status === 'busy' ? ` · ${duration(now - new Date(i.startedAt).getTime())}` : '';
    if (i.status === 'busy') return `${i.id} · ${verbose ? `${i.title} · ` : ''}${i.verb}${i.state === 'repairing' ? ` ${i.repairCycles}` : ''}${open}`;
    if (i.status === 'done') return `${i.id} · ${verbose ? `${i.title} · ` : ''}${i.chips.filter(c => c.tone !== 'neutral').map(c => c.text.toLowerCase()).join(' · ') || i.verb}`;
    if (i.status === 'fail') return `${i.id} · ${verbose ? `${i.title} · ` : ''}${i.error ?? 'failed'}${i.repairCycles ? ` · repairs ${i.repairCycles}` : ''}`;
    return `${i.id} · ${verbose ? `${i.title} · ` : ''}${i.verb}${i.dependsOn.length && i.status === 'next' ? ` for ${i.dependsOn.join(', ')}` : ''}`;
  };

  // Stage 1 · Plan
  const planningRuns = runList.filter(r => r.phase === 'planning');
  const leadId = planningRuns[0]?.agentId || roster.find(a => a.capabilities.includes('planning') && a.delegation?.canDelegate)?.id || roster.find(a => a.capabilities.includes('planning'))?.id;
  const lead = member({ id: leadId ?? 'tech-lead', stage: 'plan', status: plan ? 'done' : task.state === 'planning' ? 'busy' : terminal ? 'aborted' : 'next', role: 'lead' });
  if (plan) {
    const ms = sumRuns(planningRuns.filter(r => r.endedAt));
    lead.lines.push(`Plan v${task.version} · ${plural(plan.items.length, 'item')}${planningRuns.some(r => r.endedAt) ? ` · ${duration(ms)}` : ''}`);
    lead.durationMs = ms; if (planningRuns[0]) lead.startedAt = planningRuns[0].startedAt; const last = planningRuns.filter(r => r.endedAt).pop(); if (last?.endedAt) lead.finishedAt = last.endedAt;
    const a = task.approval?.status;
    lead.lines.push(a === 'approved' ? `You approved${task.approval?.timestamp ? ` ${clock(task.approval.timestamp)}` : ''}` : a === 'awaiting' ? 'Waiting for your approval' : a === 'not-approved' ? 'Rejected by you' : a === 'autonomous' ? 'Approved automatically' : `Finished${lead.finishedAt ? ` ${clock(lead.finishedAt)}` : ''}`);
  } else if (task.state === 'planning') { const open = planningRuns.find(r => !r.endedAt); lead.lines.push(`Planning now${open ? ` · ${duration(now - new Date(open.startedAt).getTime())}` : ''}`); lead.startedAt = open?.startedAt ?? task.createdAt; }
  else lead.lines.push(task.state === 'awaiting_mode' ? 'Plans after you choose a mode' : terminal ? 'No plan was stored' : 'Plans when the task starts');
  const you: BoardMember | undefined = task.state === 'awaiting_mode' || task.state === 'awaiting_plan_approval'
    ? member({ id: 'you', name: 'You', role: 'you', stage: 'plan', status: 'you', lines: task.state === 'awaiting_mode' ? ['Choose autonomous or plan-approval', 'Nothing runs until you decide'] : [`Approve plan version ${task.version}, or reject it`, 'Nothing runs until you decide'] })
    : undefined;
  const planStage: BoardStage = { key: 'plan', number: 1, title: 'Plan', status: you ? 'you' : lead.status, chip: you ? { tone: 'warn', text: '● Needs you' } : lead.status === 'done' ? { tone: 'ok', text: '✓ Done' } : lead.status === 'busy' ? { tone: 'run', text: '▶ Planning' } : { tone: 'neutral', text: lead.status === 'aborted' ? 'Not reached' : 'Up next' }, members: task.state === 'awaiting_mode' && you ? [you, lead] : you ? [lead, you] : [lead] };

  // Stage 2 · Build
  const groups = new Map<string, (typeof items)[number][]>();
  for (const i of items) { const k = i.agentId ?? '?'; groups.set(k, [...(groups.get(k) ?? []), i]); }
  const developers: BoardMember[] = [...groups.entries()].map(([id, its]) => {
    const statuses = its.map(i => i.status);
    const status: BoardStatus = statuses.includes('busy') ? 'busy' : statuses.includes('fail') ? 'fail' : statuses.includes('next') ? (terminal ? 'aborted' : 'next') : statuses.includes('aborted') ? 'aborted' : statuses.every(s => s === 'off') ? 'off' : 'done';
    const m = member({ id: id === '?' ? '?' : id, name: id === '?' ? 'Any eligible agent' : nameOf(id), role: id === '?' ? 'developer' : roleOf(agent(id)), stage: 'build', status, items: its, repairing: its.some(i => i.state === 'repairing') });
    const own = implementationRuns.filter(r => r.agentId === id && (multi ? its.some(i => i.id === r.workItemId) : true));
    m.durationMs = sumRuns(own); if (own[0]) m.startedAt = own[0].startedAt; const last = own.filter(r => r.endedAt).pop(); if (last?.endedAt && status !== 'busy') m.finishedAt = last.endedAt;
    if (its.length === 1) m.lines.push(itemLine(its[0]!, true));
    else { const done = its.filter(i => i.status === 'done').length; const busy = its.filter(i => i.status === 'busy'); m.lines.push(`${plural(its.length, 'item')} · ${done} integrated${busy.length ? ` · ${busy.map(i => `${i.id} ${i.verb}`).join(', ')}` : ''}${its.some(i => i.status === 'fail') ? ` · ${its.filter(i => i.status === 'fail').map(i => i.id).join(', ')} failed` : ''}`); m.lines.push(its.map(i => i.id).join(', ')); }
    if (its.length === 1 && status === 'next' && !terminal) m.lines.push(task.state === 'awaiting_plan_approval' || task.state === 'awaiting_mode' ? 'Starts after your decision' : its[0]!.dependsOn.length ? `Waits for ${its[0]!.dependsOn.join(', ')}` : 'Starts when a slot is free');
    return m;
  });
  const doneItems = items.filter(i => i.status === 'done').length; const busyItems = items.filter(i => i.status === 'busy').length; const failedItems = items.filter(i => i.status === 'fail').length;
  const buildStatus: BoardStatus = !items.length ? (terminal ? 'aborted' : 'next') : busyItems ? 'busy' : failedItems ? 'fail' : doneItems === items.length ? 'done' : terminal ? 'aborted' : 'next';
  const buildStage: BoardStage = { key: 'build', number: 2, title: 'Build', status: buildStatus, members: developers, chip: buildStatus === 'done' ? { tone: 'ok', text: '✓ Done' } : buildStatus === 'busy' ? { tone: 'run', text: `▶ ${doneItems} of ${items.length} done` } : buildStatus === 'fail' ? { tone: 'bad', text: `✕ ${failedItems} stopped` } : buildStatus === 'aborted' ? { tone: 'neutral', text: doneItems ? `${doneItems} of ${items.length} done` : 'Not reached' } : { tone: 'neutral', text: 'Up next' } };

  // Stage 3 · Review
  const reviewRuns = runList.filter(r => r.phase === 'review');
  const reviewerIds = [...new Set(reviewRuns.map(r => r.agentId).filter(Boolean))];
  if (!reviewerIds.length) { const r = roster.find(a => a.capabilities.includes('review') && !groups.has(a.id)) ?? roster.find(a => a.capabilities.includes('review')); if (r) reviewerIds.push(r.id); else if (reviewRuns.length) reviewerIds.push('reviewer'); }
  const finalReview = reviewRuns.filter(r => r.endedAt && (multi ? r.workItemId === '@integration' : true)).pop();
  const finalApproved = task.state === 'committing' || task.state === 'completed' || (finalReview?.output ? reviewOf(finalReview.output)?.approved === true : false);
  const reviewers: BoardMember[] = reviewerIds.map(id => {
    const own = reviewRuns.filter(r => r.agentId === id || (id === 'reviewer' && !r.agentId)); const open = own.find(r => !r.endedAt);
    const itemReviews = items.map(i => perItem.get(i.id)?.review).filter((r): r is NonNullable<typeof r> => !!r);
    const approved = itemReviews.filter(r => r.approved).length; const rejected = itemReviews.length - approved; const findings = itemReviews.reduce((t, r) => t + r.findings, 0);
    const status: BoardStatus = open ? 'busy' : finalApproved ? 'done' : terminal ? 'aborted' : 'next';
    const m = member({ id, stage: 'review', status, role: 'reviewer', ...(id === 'reviewer' ? { name: 'Reviewer' } : {}) });
    m.durationMs = sumRuns(own.filter(r => r.agentId === id)); if (own[0]) m.startedAt = own[0].startedAt; const last = own.filter(r => r.endedAt).pop(); if (last?.endedAt && !open) m.finishedAt = last.endedAt;
    m.lines.push(itemReviews.length ? `${approved} ✓${rejected ? ` · ${rejected} ✕` : ''} · ${plural(findings, 'finding')}${multi && finalApproved ? ' · final review approved' : ''}` : finalApproved ? 'Final review approved' : 'No reviews yet');
    if (open) m.lines.push(`Now: ${open.workItemId && open.workItemId !== '@integration' ? `item ${open.workItemId}` : multi ? 'the combined diff' : 'the diff'} · ${duration(now - new Date(open.startedAt).getTime())}`);
    else if (status === 'next') { const pending = items.find(i => i.status !== 'done' && !perItem.get(i.id)?.review?.approved); m.lines.push(pending ? `Next: item ${pending.id}, once its tests pass` : multi ? 'Next: the combined diff after integration' : 'Next: the diff after validation'); }
    else if (status === 'aborted') { m.lines.push(multi ? 'Final review not reached' : 'Review not reached'); m.reason = 'not reached'; }
    return m;
  });
  const reviewStatus: BoardStatus = reviewers.some(r => r.status === 'busy') ? 'busy' : reviewers.every(r => r.status === 'done') && reviewers.length ? 'done' : reviewers.some(r => r.status === 'aborted') ? 'aborted' : 'next';
  const reviewedCount = items.filter(i => perItem.get(i.id)?.review?.approved).length;
  const reviewStage: BoardStage = { key: 'review', number: 3, title: 'Review', status: reviewStatus, members: reviewers, chip: reviewStatus === 'done' ? { tone: 'ok', text: '✓ Done' } : reviewStatus === 'busy' ? { tone: 'run', text: '▶ Working' } : reviewStatus === 'aborted' ? { tone: 'neutral', text: 'Not reached' } : multi && reviewedCount ? { tone: 'neutral', text: `${reviewedCount} of ${items.length}` } : { tone: 'neutral', text: 'Up next' } };

  // Stage 4 · Integrate (multi-item only)
  let integrateStage: BoardStage | undefined;
  if (multi && plan) {
    const integrationRuns = runList.filter(r => r.workItemId === '@integration' && r.phase !== 'review');
    const combined = perItem.get('@integration'); const lastCombined = combined?.tests[combined.tests.length - 1];
    const allDone = items.length > 0 && doneItems === items.length;
    const status: BoardStatus = task.state === 'committing' || task.state === 'completed' || (lastCombined?.exitCode === 0 && !lastCombined.truncated && allDone && reviewStatus !== 'busy') ? 'done'
      : integrationRuns.some(r => !r.endedAt) || (allDone && !terminal && ['running', 'validating', 'repairing'].includes(task.state)) ? 'busy' : terminal ? 'aborted' : 'next';
    const id = plan.integration?.assignedAgent ?? 'general-developer';
    const m = member({ id, stage: 'integrate', status, role: roleOf(agent(id)) });
    const commands = new Set([...plan.items.flatMap(i => i.validation), ...(plan.integration?.validation ?? [])].map(command)).size;
    m.lines.push(`Combined validation · ${plural(commands, 'command')}${combined?.tests.length ? ` · ${lastCombined!.exitCode === 0 ? '✓' : `✕ exit ${lastCombined!.exitCode}`}` : ''}`);
    m.lines.push(status === 'aborted' ? 'Not reached' : status === 'done' ? 'Final review followed' : 'Then a final review');
    m.durationMs = sumRuns(integrationRuns);
    integrateStage = { key: 'integrate', number: 4, title: 'Integrate', status, members: [m], chip: status === 'done' ? { tone: 'ok', text: '✓ Done' } : status === 'busy' ? { tone: 'run', text: '▶ Working' } : status === 'aborted' ? { tone: 'neutral', text: 'Not reached' } : { tone: 'neutral', text: 'Up next' } };
  }

  // Stage 5 · Commit
  const commitStatus: BoardStatus = task.outcome?.commit ? 'done' : task.state === 'committing' ? 'busy' : terminal ? 'aborted' : 'next';
  const system = member({ id: 'devagents', name: 'DevAgents', role: 'system', stage: 'commit', status: commitStatus });
  if (commitStatus === 'done') { system.lines.push(`Committed ${short(task.outcome?.commit)} · ${clock(commitAt ?? task.updatedAt)}`); system.lines.push('You integrate it yourself'); system.finishedAt = commitAt ?? task.updatedAt; }
  else if (commitStatus === 'aborted') { system.lines.push('No commit'); system.lines.push(task.state === 'cancelled' ? 'Cancelled by you' : 'The task stopped first'); }
  else if (commitStatus === 'busy') system.lines.push('Creating the reviewed local commit');
  else { system.lines.push(`One local commit on ${task.workspace?.branch ?? 'the task branch'}`); system.lines.push('Nothing is merged or pushed'); }
  const commitStage: BoardStage = { key: 'commit', number: integrateStage ? 5 : 4, title: 'Commit', status: commitStatus, members: [system], chip: commitStatus === 'done' ? { tone: 'ok', text: '✓ Done' } : commitStatus === 'busy' ? { tone: 'run', text: '▶ Committing' } : commitStatus === 'aborted' ? { tone: 'neutral', text: task.state === 'cancelled' ? 'Cancelled' : 'No commit' } : { tone: 'neutral', text: 'Up next' } };

  const stages = [planStage, buildStage, reviewStage, ...(integrateStage ? [integrateStage] : []), commitStage];

  // Not needed: enabled roster members the plan gave nothing to do.
  const involved = new Set(stages.flatMap(s => s.members.map(m => m.id)));
  const required = new Set((plan?.items ?? []).flatMap(i => i.requiredCapabilities));
  const notNeeded: BoardMember[] = roster.filter(a => !involved.has(a.id)).map(a => {
    const cap = ['testing', 'review', 'implementation', 'backend', 'frontend', 'planning'].find(c => a.capabilities.includes(c) && !required.has(c));
    return member({ id: a.id, stage: 'build', status: 'off', role: roleOf(a), lines: [plan ? (cap ? `Not needed: no item asks for ${cap}` : 'Not needed: not assigned by the plan') : 'Waits for the plan'], reason: cap ? `no item asks for ${cap}` : 'not assigned by the plan' });
  });

  // The ordered member list: one card per member, merged across stages, most urgent status first.
  const merged = new Map<string, BoardMember>();
  for (const s of stages) for (const m of s.members) {
    const prev = merged.get(m.id);
    if (!prev) { merged.set(m.id, { ...m, key: `member:${m.id}`, lines: [...m.lines], items: [...m.items] }); continue; }
    const pick = RANK[m.status] < RANK[prev.status] ? m : prev;
    merged.set(m.id, { ...prev, status: pick.status, repairing: prev.repairing || m.repairing, lines: [...prev.lines, ...m.lines], items: [...prev.items, ...m.items], durationMs: (prev.durationMs ?? 0) + (m.durationMs ?? 0), ...(pick.reason ? { reason: pick.reason } : {}) });
  }
  const list = [...merged.values()].sort((a, b) => RANK[a.status] - RANK[b.status]);
  const people = list.filter(m => m.role !== 'you' && m.role !== 'system');
  const count = (s: BoardStatus) => people.filter(m => m.status === s).length;
  const counts: Counts = { involved: people.filter(m => m.id !== '?').length, roster: roster.length, finished: count('done'), working: count('busy'), next: count('next'), needsYou: you ? 1 : 0, failed: count('fail'), aborted: count('aborted') };
  const parts = [`${counts.involved} of ${plural(counts.roster, 'member')} involved`, `${counts.finished} finished`, `${counts.working} working`, `${counts.next} up next`];
  if (counts.failed) parts.push(`${counts.failed} stopped`); if (counts.aborted) parts.push(`${counts.aborted} did not get a turn`); if (you) parts.push('1 decision is yours');
  return { stages, list, notNeeded, counts, summary: parts.join(' · '), multi };
}

/** The fold rule: up to `limit` full rows; past that finished rows fold into a stack first, then up-next rows, then aborted/not-needed rows. Working, failed and needs-you rows never fold, and a group of one is never folded. */
export type FoldedRow<T> = { kind: 'row'; row: T } | { kind: 'stack'; status: BoardStatus; rows: T[] };
export function fold<T extends { status: BoardStatus }>(rows: T[], limit = FOLD_LIMIT): FoldedRow<T>[] {
  let full = rows.length; const folded = new Set<BoardStatus>();
  for (const group of [['done'], ['next'], ['aborted', 'off']] as BoardStatus[][]) {
    if (full <= limit) break;
    const size = rows.filter(r => group.includes(r.status)).length;
    if (size < 2) continue;
    for (const s of group) folded.add(s); full -= size;
  }
  const out: FoldedRow<T>[] = []; const stacks = new Map<string, FoldedRow<T> & { kind: 'stack' }>();
  for (const row of rows) {
    if (!folded.has(row.status)) { out.push({ kind: 'row', row }); continue; }
    const key = row.status === 'off' ? 'aborted' : row.status;
    let s = stacks.get(key); if (!s) { s = { kind: 'stack', status: key as BoardStatus, rows: [] }; stacks.set(key, s); out.push(s); }
    s.rows.push(row);
  }
  return out;
}
export const statusLabel: Record<BoardStatus, string> = { done: 'finished', busy: 'working now', next: 'up next', you: 'needs you', fail: 'stopped', aborted: 'did not get a turn', off: 'not needed' };
export const statusBadge: Record<BoardStatus, string> = { done: '✓', busy: '▶', next: '…', you: '!', fail: '✕', aborted: '⚠', off: '–' };
