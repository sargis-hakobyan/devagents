import { useEffect, useRef, useState } from 'preact/hooks';
import { api, ApiError, SignedOutError, type Task } from '../api';
import { onSignedOut, useConnection } from '../state';

export function TaskActions({ task, reload, showPlan }: { task: Task; reload: () => void; showPlan: () => void }) {
  const [busy, setBusy] = useState(false); const lock = useRef(false);
  const [error, setError] = useState(''); const [confirm, setConfirm] = useState(false);
  const [reviewedVersion, setReviewedVersion] = useState<number | undefined>(task.state === 'awaiting_plan_approval' ? task.version : undefined);
  const [stale, setStale] = useState(false); const online = useConnection().online;
  const changed = task.state === 'awaiting_plan_approval' && (stale || (reviewedVersion !== undefined && reviewedVersion !== task.version));
  useEffect(() => { if (task.state === 'awaiting_plan_approval' && reviewedVersion === undefined) setReviewedVersion(task.version); }, [task.version, task.state]);
  useEffect(() => { setConfirm(false); }, [task.id, task.state]);
  const act = async (action: 'mode' | 'approve' | 'cancel', body: unknown = {}) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    const version = task.version;
    try { await api(`/tasks/${task.id}/${action}`, { method: 'POST', body: action === 'approve' ? { version } : body }); setConfirm(false); reload(); }
    catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      if (e instanceof ApiError && e.status === 409) { setStale(true); setConfirm(false); reload(); }
      if (e instanceof SignedOutError) onSignedOut();
      // An unknown outcome is never replayed; refresh durable state before another decision.
      reload();
    } finally { lock.current = false; setBusy(false); }
  };
  const terminal = ['completed', 'failed', 'cancelled'].includes(task.state);
  return <div class="task-actions">
    {error && <div class="note bad" role="alert">{error} <span>Reloaded task state; no action is retried automatically.</span></div>}
    {changed && <div class="note warn">The plan version changed or approval was refused. Read the current plan before deciding again. <button class="btn small" disabled={busy || !online} onClick={() => { showPlan(); setReviewedVersion(task.version); setStale(false); }}>Review updated plan</button></div>}
    <div class="actions">
      {task.state === 'awaiting_mode' && <><button class="btn primary" disabled={busy || !online} onClick={() => void act('mode', { mode: 'plan-approval' })}>Choose plan approval</button><button class="btn" disabled={busy || !online} onClick={() => void act('mode', { mode: 'autonomous' })}>Choose autonomous</button></>}
      {task.state === 'awaiting_plan_approval' && <><button class="btn primary" disabled={busy || !online || changed} onClick={() => void act('approve')}>Approve version {task.version}</button><button class="btn" disabled={busy || !online} onClick={() => setConfirm(true)}>Reject plan · cancels the task</button></>}
      {!terminal && !['awaiting_plan_approval', 'committing'].includes(task.state) && <button class="btn" disabled={busy || !online} onClick={() => setConfirm(true)}>Cancel task…</button>}
      {task.state === 'committing' && <span class="chip neutral">Committing · not cancellable</span>}
      {busy && <span role="status">Sending decision…</span>}
    </div>
    {confirm && !terminal && task.state !== 'committing' && <div class="note warn"><b>{task.state === 'awaiting_plan_approval' ? `Reject plan version ${task.version} and cancel this task?` : 'Cancel this task?'}</b><p>Stops workers and preserves worktrees for inspection. This does not delete work or submit another task.</p><div class="actions"><button class="btn" disabled={busy || !online} onClick={() => void act('cancel')}>{task.state === 'awaiting_plan_approval' ? 'Reject and cancel' : 'Confirm cancellation'}</button><button class="btn" disabled={busy} onClick={() => setConfirm(false)}>Keep waiting</button></div></div>}
  </div>;
}
