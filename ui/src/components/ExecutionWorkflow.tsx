import { useEffect } from 'preact/hooks';
import type { Execution, ExecutionEntry } from '../../../src/domain/execution';
import { api } from '../api';
import { executionRows } from '../execution-view';
import { forget, usePoll } from '../state';
import { clock, duration, type BoardStatus } from '../team-board';
import { Avatar } from './TeamBoard';
import { ErrorNote, Skeleton, Stage } from './ui';

const phases: Record<string, string> = { planning: 'Planning', setup: 'Environment setup', implementation: 'Implementation', review: 'Code review', qa: 'Quality assurance', validation: 'Validation', commit: 'Commit' };
const statuses: Record<ExecutionEntry['status'], { label: string; board: BoardStatus; tone: 'ok' | 'run' | 'warn' | 'bad' | 'neutral' }> = {
  approved: { label: 'Approved', board: 'done', tone: 'ok' },
  running: { label: 'Working now', board: 'busy', tone: 'run' }, completed: { label: 'Finished', board: 'done', tone: 'ok' },
  'changes-requested': { label: 'Changes requested', board: 'blocked', tone: 'warn' }, failed: { label: 'Failed', board: 'fail', tone: 'bad' },
  interrupted: { label: 'Interrupted', board: 'aborted', tone: 'neutral' }, blocked: { label: 'Blocked', board: 'blocked', tone: 'warn' },
};
export function ExecutionWorkflow({ taskId, now, onActivity }: { taskId: string; now: number; onActivity: (scope?: string) => void }) {
  const key = `execution:${taskId}`;
  useEffect(() => () => forget(key), [key]);
  const execution = usePoll(key, () => api<Execution>(`/tasks/${taskId}/execution`), 3000);
  const entries = execution.data?.entries ?? [];
  const rows = executionRows(entries);
  const numbers = new Map(entries.filter(e => e.kind === 'agent').map((entry, i) => [entry.id, i + 1]));
  const targets = new Map(rows.flatMap(row => (row.checks.length ? row.checks : [row.entry]).map(e => [e.id, row.entry.id])));
  const working = entries.filter(e => e.status === 'running');
  return <section class="memberlist execution" aria-label="Execution workflow">
    <header class="workflow-heading"><h2>Execution workflow</h2><p>Who worked, in start order, including every review and repair. Automated checks are grouped below each handoff. Updates every 3 seconds.</p></header>
    {execution.error && <div><ErrorNote message={`Execution updates unavailable: ${execution.error}`} /><button class="btn small" onClick={execution.reload}>Retry execution updates</button></div>}
    {!execution.data && execution.loading && <Skeleton rows={3} label="Loading execution history" />}
    {execution.data && <>
      <div class="note info" role="status">{working.length ? `Working now: ${working.map(e => `${e.actor} · ${phases[e.phase] ?? e.phase} · ${e.scopeLabel}`).join('; ')}` : `Task state: ${execution.data.state.replaceAll('_', ' ')}. ${entries.length ? 'No agent call is currently running.' : 'No agent runs recorded yet.'}`}</div>
      <ol class="workflow-steps">
        {rows.map(({ entry, checks }) => {
          if (entry.kind === 'validation') {
            const failed = checks.filter(c => c.status === 'failed').length;
            return <li key={entry.id} id={`execution-${entry.id}`} class={`workflow-step execution-automation ${failed ? 'fail' : 'done'}`} data-validation-group>
              <span class="execution-check-marker" aria-hidden="true">{failed ? '!' : '✓'}</span>
              <details class="execution-checks">
                <summary><b>{checks.length} automated {checks.length === 1 ? 'check' : 'checks'}</b><span class={`stage ${failed ? 'bad' : 'ok'}`}>{checks.length - failed} passed{failed ? ` · ${failed} failed` : ''}</span></summary>
                <ul>{checks.map(check => <li key={check.id} data-validation-id={check.id}><Stage tone={check.status === 'failed' ? 'bad' : 'ok'}>{check.status === 'failed' ? 'Failed' : 'Passed'}</Stage><span class="wrap-anywhere">{check.scopeLabel} · {check.summary}</span><span class="what">{clock(check.startedAt)}</span></li>)}</ul>
              </details>
            </li>;
          }
          if (entry.kind === 'commit') return <li key={entry.id} id={`execution-${entry.id}`} class="workflow-step execution-automation done"><span class="execution-check-marker" aria-hidden="true">✓</span><div class="execution-commit wrap-anywhere"><b>{entry.summary}</b><span class="what">{clock(entry.startedAt)}</span></div></li>;
          const status = statuses[entry.status];
          const role = entry.phase === 'planning' ? 'lead' : entry.phase === 'review' ? 'reviewer' : entry.phase === 'qa' ? 'qa' : 'developer';
          const repair = entry.phase === 'implementation' && entry.follows.length > 0;
          const phase = repair ? 'Repair' : phases[entry.phase] ?? entry.phase;
          return <li key={entry.id} id={`execution-${entry.id}`} data-execution-id={entry.id} class={`workflow-step ${status.board}`}>
            <span class="workflow-number" aria-hidden="true">{numbers.get(entry.id)}</span>
            <article class={`card mcard execution-card ${entry.status === 'running' ? 'now' : ''}`} data-status={entry.status} data-agent={entry.agentId ?? 'devagents'}>
              <header class="execution-title">
                <Avatar role={role} status={status.board} repairing={repair} />
                <div class="execution-identity"><h3>{entry.actor}</h3><div class="what wrap-anywhere">{phase} · {entry.scopeLabel}{entry.kind === 'agent' ? ` · Attempt ${entry.attempt}` : ''}</div></div>
                <Stage tone={status.tone}>{status.label}</Stage>
              </header>
              <div class="what">{entry.kind === 'agent' ? <>{clock(entry.startedAt)}{entry.finishedAt ? ` → ${clock(entry.finishedAt)} · ${duration(Date.parse(entry.finishedAt) - Date.parse(entry.startedAt))}` : entry.status === 'running' ? ` · ${duration(now - Date.parse(entry.startedAt))} elapsed` : ' · completion time unavailable'}</> : <>Recorded at {clock(entry.startedAt)}</>}</div>
              {entry.parallelWith.length > 0 && <div class="what">Overlapped with {entry.parallelWith.map((id, i) => <span key={id}>{i ? ', ' : ''}<a href={`#execution-${id}`}>step {numbers.get(id)}</a></span>)} · parallel work</div>}
              {entry.follows.length > 0 && <div class="note warn execution-handoff"><b>Following feedback</b>{entry.follows.map(f => <div key={f.id}><a href={`#execution-${targets.get(f.id) ?? f.id}`}>{numbers.has(f.id) ? `From step ${numbers.get(f.id)}` : 'From automated checks'}</a><p class="wrap-anywhere">{f.reason}</p></div>)}</div>}
              {entry.summary && <div><p class="execution-summary wrap-anywhere">{entry.summary.length > 320 ? `${entry.summary.slice(0, 320)}…` : entry.summary}</p>{entry.summary.length > 320 && <details class="execution-report"><summary>Read recorded report</summary><p class="execution-summary wrap-anywhere">{entry.summary}</p></details>}</div>}
              {entry.findings.length > 0 && <div class="execution-findings"><b>{entry.phase === 'review' ? 'Reviewer findings' : 'Findings'}</b><ul>{entry.findings.map((finding, i) => <li key={i} class="wrap-anywhere">{finding}</li>)}</ul></div>}
              {repair && entry.status === 'completed' && <div class="what">Repair run finished. Check the later validation and review steps for verification.</div>}
              <div><button type="button" class="btn small" onClick={() => onActivity(entry.scope === '@task' ? undefined : entry.scope)}>Open activity</button></div>
            </article>
          </li>;
        })}
      </ol>
    </>}
  </section>;
}
