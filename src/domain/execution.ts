/** Compact, chronological execution facts. No prompts, tool output or credentials enter this view. */
export type ExecutionEvent = { sequence: number; kind: string; at: string; data: Record<string, unknown> };
export type ExecutionEntry = {
  id: string; sequence: number; kind: 'agent' | 'validation' | 'commit'; actor: string; agentId: string | null;
  phase: string; scope: string; scopeLabel: string; attempt: number; startedAt: string; finishedAt: string | null;
  status: 'running' | 'completed' | 'approved' | 'changes-requested' | 'failed' | 'interrupted' | 'blocked';
  summary: string; findings: string[]; follows: { id: string; reason: string }[]; parallelWith: string[];
};
export type Execution = { state: string; updatedAt: string; entries: ExecutionEntry[] };
type TaskFacts = {
  state: string; updatedAt: string;
  agents?: { id: string; name: string }[] | undefined; team?: { members: { id: string; name: string }[] } | undefined;
  plan?: { items: { id: string; title: string }[] } | undefined;
};
const str = (v: unknown) => typeof v === 'string' ? v : '';
const strings = (v: unknown) => Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string').slice(0, 50).map(s => s.slice(0, 4000)) : [];

export function taskExecution(task: TaskFacts, events: ExecutionEvent[]): Execution {
  const entries: ExecutionEntry[] = []; const runs = new Map<string, ExecutionEntry>();
  const attempts = new Map<string, number>();
  const pending = new Map<string, Map<string, { id: string; reason: string }>>();
  const names = new Map((task.team?.members ?? task.agents ?? []).map(a => [a.id, a.name]));
  const issues = (scope: string) => { let value = pending.get(scope); if (!value) { value = new Map(); pending.set(scope, value); } return value; };
  for (const event of events) {
    const d = event.data; const scope = str(d.workItemId) || '@task';
    const label = scope === '@integration' ? 'Combined result' : scope === '@task' ? 'Task' : task.plan?.items.find(i => i.id === scope)?.title ?? scope;
    const runId = str(d.runId);
    if (event.kind === 'run-started' && runId && !runs.has(runId)) {
      const phase = str(d.phase); const agentId = str(d.agentId) || null;
      const key = JSON.stringify([scope, phase]); const attempt = (attempts.get(key) ?? 0) + 1; attempts.set(key, attempt);
      const entry: ExecutionEntry = { id: `run-${runId}`, sequence: event.sequence, kind: 'agent', actor: names.get(agentId ?? '') ?? agentId ?? 'Unknown agent', agentId,
        phase, scope, scopeLabel: label, attempt, startedAt: event.at, finishedAt: null, status: 'running', summary: '', findings: [],
        follows: phase === 'implementation' ? [...issues(scope).values()] : [], parallelWith: [] };
      // Sequence order proves which runs were still open when this one started, even with equal timestamps.
      for (const other of runs.values()) if (other.status === 'running') { other.parallelWith.push(entry.id); entry.parallelWith.push(other.id); }
      if (phase === 'implementation') issues(scope).clear();
      entries.push(entry); runs.set(runId, entry);
    } else if (event.kind === 'run-completed' || event.kind === 'run-failed') {
      const entry = runs.get(runId); if (!entry || entry.finishedAt) continue;
      entry.finishedAt = event.at; entry.status = event.kind === 'run-failed' ? 'failed' : 'completed';
      entry.summary = str(d.error) || str(d.summary); entry.findings = strings(d.findings);
      if (event.kind === 'run-completed' && entry.phase === 'review') {
        if (d.approved === false || d.approved === 0 || entry.findings.length) {
          entry.status = 'changes-requested';
          issues(entry.scope).set('review', { id: entry.id, reason: entry.findings.join('\n') || entry.summary || 'Reviewer requested changes.' });
        } else if (d.approved === true || d.approved === 1) { entry.status = 'approved'; issues(entry.scope).delete('review'); }
      }
    } else if (event.kind === 'qa-result') {
      const entry = [...entries].reverse().find(r => r.kind === 'agent' && r.phase === 'qa' && r.scope === scope);
      if (!entry) continue;
      const state = str(d.state);
      if (state === 'failed' || state === 'blocked') {
        entry.status = state === 'blocked' ? 'blocked' : 'changes-requested'; entry.findings = [str(d.feedback) || str(d.summary) || `QA ${state}.`];
        issues(scope).set('qa', { id: entry.id, reason: entry.findings[0]! });
      } else if (state === 'passed') issues(scope).delete('qa');
    } else if (event.kind === 'validation' || event.kind === 'commit-created') {
      const validation = event.kind === 'validation';
      const command = [str(d.executable), ...strings(d.args)].join(' ');
      const truncated = d.truncated === true || d.truncated === 1;
      const failed = validation && (d.exitCode !== 0 || truncated);
      const entry: ExecutionEntry = { id: `evidence-${event.sequence}`, sequence: event.sequence, kind: validation ? 'validation' : 'commit', actor: 'DevAgents', agentId: null,
        phase: validation ? 'validation' : 'commit', scope, scopeLabel: label, attempt: 1, startedAt: event.at, finishedAt: event.at,
        status: failed ? 'failed' : 'completed', summary: validation ? command : `Created local commit ${str(d.commit)}`, findings: [], follows: [], parallelWith: [] };
      entries.push(entry);
      if (validation) {
        if (failed) issues(scope).set(command, { id: entry.id, reason: `Validation failed: ${command} (${truncated ? 'output truncated' : `exit ${d.exitCode ?? 'unknown'}`}).` });
        else issues(scope).delete(command);
      }
    }
  }
  if (['completed', 'failed', 'cancelled'].includes(task.state)) for (const entry of runs.values()) {
    if (entry.status === 'running') { entry.status = 'interrupted'; entry.summary = 'No completion was recorded before the task stopped.'; }
  }
  return { state: task.state, updatedAt: task.updatedAt, entries };
}
