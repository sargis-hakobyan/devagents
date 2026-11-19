import type { TaskFailure } from '../task-failure';

export function TaskFailureNotice({ failure, onActivity }: { failure: TaskFailure; onActivity: () => void }) {
  return <section class="note bad wrap-anywhere" aria-label="Why this task failed">
    <b>{failure.title}</b>
    <p>{failure.reason}</p>
    {failure.report && <div><b>Developer’s explanation</b><p style={{ whiteSpace: 'pre-wrap' }}>{failure.report}</p><p class="muted">This is the developer’s report. It was not independently reviewed.</p></div>}
    <p><b>What to do next:</b> {failure.nextStep}</p>
    <button class="btn" type="button" onClick={onActivity}>View failure activity</button>
    {failure.technical && failure.technical !== failure.reason && <details style={{ marginTop: '10px' }}><summary>Technical details</summary><pre class="wrap-anywhere">{failure.technical}</pre></details>}
  </section>;
}
