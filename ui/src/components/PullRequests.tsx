import { useRef, useState } from 'preact/hooks';
import { api, SignedOutError, type ProjectPullRequests, type StepMode, type TaskPullRequestView } from '../api';
import { formatTime } from '../format';
import { onSignedOut, retryNow, usePoll } from '../state';
import { Card, Chip, ErrorNote, Skeleton } from './ui';

const MODES: { key: StepMode; title: string }[] = [{ key: 'off', title: 'Off' }, { key: 'ask', title: 'Ask me' }, { key: 'auto', title: 'Automatic' }];
const message = (e: unknown) => e instanceof Error ? e.message : String(e);

/** The project's choices for what happens on GitHub after a task finishes. Shown once GitHub is connected. */
export function ProjectPullRequestsCard({ projectId }: { projectId: string }) {
  const key = `project-pull-requests:${projectId}`;
  const saved = usePoll(key, () => api<ProjectPullRequests>(`/projects/${projectId}/pull-requests`), 15000);
  const connected = saved.data?.connected === true;
  const branches = usePoll(`${key}:branches:${connected}`, () => connected ? api<{ branches: string[]; defaultBranch: string }>(`/projects/${projectId}/pull-requests/branches`) : Promise.resolve(undefined), 300000);
  const [draft, setDraft] = useState<ProjectPullRequests['settings']>(); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const lock = useRef(false);
  if (!saved.data) return saved.error ? <ErrorNote message={saved.error} /> : <Skeleton rows={2} label="Loading pull request settings" />;
  if (!connected) return null;
  const settings = draft ?? saved.data.settings; const off = settings.publish === 'off';
  const names = branches.data?.branches ?? []; const target = settings.targetBranch ?? '';
  const change = (next: Partial<ProjectPullRequests['settings']>) => { setError(''); setDraft({ ...settings, ...next }); };
  const setTarget = (value: string) => { const { targetBranch: _, ...rest } = settings; setError(''); setDraft(value ? { ...rest, targetBranch: value } : rest); };
  const save = async () => {
    if (lock.current || !draft) return; lock.current = true; setBusy(true); setError('');
    try { await api(`/projects/${projectId}/pull-requests`, { method: 'PUT', body: draft }); setDraft(undefined); }
    catch (e) { if (e instanceof SignedOutError) onSignedOut(); else setError(message(e)); }
    finally { lock.current = false; setBusy(false); retryNow(); }
  };
  return <Card title="After a task finishes">
    <div class="step-row">
      <span class="step-num" aria-hidden="true">1</span>
      <div class="step-text"><b id={`publish-${projectId}`}>Publish</b><span class="muted">Push the branch and open a pull request</span></div>
      <div class="step-seg" role="group" aria-labelledby={`publish-${projectId}`}>
        {MODES.map(m => <button key={m.key} type="button" aria-pressed={settings.publish === m.key} disabled={busy} onClick={() => change({ publish: m.key })}>{m.title}</button>)}
      </div>
    </div>
    <div class="step-fields">
      <label class="field">Target branch
        {names.length > 0 || !branches.error
          ? <select value={target} disabled={busy || off} onChange={e => setTarget(e.currentTarget.value)}>
            <option value="">{branches.data ? `Default branch (${branches.data.defaultBranch})` : 'Default branch'}</option>
            {target && !names.includes(target) && <option value={target}>{target}</option>}
            {names.map(name => <option key={name} value={name}>{name}</option>)}
          </select>
          : <input type="text" value={target} maxLength={200} placeholder="Default branch" disabled={busy || off} onInput={e => setTarget(e.currentTarget.value.trim())} />}
      </label>
    </div>
    {error && <div style={{ padding: '0 16px 12px' }}><div class="note bad" role="alert">{error}</div></div>}
    {draft && <div class="step-actions"><button type="button" class="btn primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button><button type="button" class="btn" disabled={busy} onClick={() => { setDraft(undefined); setError(''); }}>Discard changes</button></div>}
  </Card>;
}

/** A task's pull request, polled only while the page is open. `undefined` while loading or where the service has no integrations. */
// A task without this resource simply has nothing to show; only a lost session is passed on.
export const useTaskPullRequest = (taskId: string) => usePoll(`task-pull-request:${taskId}`, () => api<TaskPullRequestView>(`/tasks/${taskId}/pull-request`).catch((e): undefined => { if (e instanceof SignedOutError) throw e; return undefined; }), 5000);
/** Whether the task page has anything to show about a pull request. */
export const hasPullRequest = (view: TaskPullRequestView | undefined): view is TaskPullRequestView => Boolean(view && (view.pullRequest || view.canPublish || view.publishing || view.failure));

export function PullRequestChip({ view }: { view: TaskPullRequestView | undefined }) {
  if (!view?.pullRequest) return null;
  return <Chip tone="run">PR #{view.pullRequest.number}</Chip>;
}

export function PullRequestTab({ taskId, view, reload }: { taskId: string; view: TaskPullRequestView; reload: () => void }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const lock = useRef(false);
  const publish = async () => {
    if (lock.current) return; lock.current = true; setBusy(true); setError('');
    try { await api(`/tasks/${taskId}/pull-request`, { method: 'POST', body: {}, timeoutMs: 180000 }); }
    catch (e) { if (e instanceof SignedOutError) onSignedOut(); else setError(message(e)); }
    finally { lock.current = false; setBusy(false); reload(); }
  };
  const pr = view.pullRequest; const working = busy || view.publishing; const failure = error || view.failure?.message;
  return <Card title={pr ? `Pull request #${pr.number}` : 'Pull request'} right={pr && <a class="btn small" href={pr.url} target="_blank" rel="noreferrer">View on GitHub</a>}>
    <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '12px', alignItems: 'flex-start' }}>
      {pr ? <>
        <Chip tone="ok">✓ Opened {formatTime(pr.openedAt)}{pr.draft ? ' · draft' : ''}</Chip>
        <span class="muted wrap-anywhere" style={{ fontSize: '13.5px' }}><span class="mono">{pr.repository}</span> · <span class="mono">{pr.branch}</span> → <span class="mono">{pr.base}</span></span>
      </> : <>
        {failure && <div class="note bad" role="alert">{failure}</div>}
        <button type="button" class="btn primary" disabled={working || !view.canPublish} onClick={() => void publish()}>{working ? 'Opening the pull request…' : failure ? 'Try again' : 'Open pull request'}</button>
      </>}
    </div>
  </Card>;
}
