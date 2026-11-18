import { useRef, useState } from 'preact/hooks';
import { api, SignedOutError, type ProjectPullRequests, type PullRequestCheck, type PullRequestStatusCode, type StepMode, type TaskPullRequestView } from '../api';
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

type Tone = 'ok' | 'run' | 'warn' | 'bad' | 'neutral';
const TONES: Record<PullRequestStatusCode, Tone> = { 'not-read': 'run', merged: 'ok', closed: 'neutral', 'checks-failed': 'bad', 'checks-running': 'run', conflict: 'bad', 'comments-open': 'warn', waiting: 'neutral', ready: 'ok' };
/** `PR #42 · checks running`, coloured by what stands between the pull request and a merge. */
export function PullRequestStatusChip({ pullRequest }: { pullRequest: { number: number; status: string; code: PullRequestStatusCode } }) {
  return <Chip tone={TONES[pullRequest.code]}>PR #{pullRequest.number} · {pullRequest.status}</Chip>;
}
export function PullRequestChip({ view }: { view: TaskPullRequestView | undefined }) {
  if (!view?.pullRequest) return null;
  return view.github ? <PullRequestStatusChip pullRequest={{ number: view.github.number, status: view.github.status.text, code: view.github.status.code }} /> : <Chip tone="run">PR #{view.pullRequest.number}</Chip>;
}

const CHECK: Record<PullRequestCheck['status'], { icon: string; label: string; tone: string }> = { passed: { icon: '✓', label: 'Passed', tone: 'ok' }, failed: { icon: '✕', label: 'Failed', tone: 'bad' }, running: { icon: '…', label: 'Running', tone: 'run' }, skipped: { icon: '–', label: 'Skipped', tone: 'neutral' } };
const count = (n: number, word: string) => `${n} ${word}`;

export function PullRequestTab({ taskId, view, reload }: { taskId: string; view: TaskPullRequestView; reload: () => void }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const lock = useRef(false);
  const publish = async () => {
    if (lock.current) return; lock.current = true; setBusy(true); setError('');
    try { await api(`/tasks/${taskId}/pull-request`, { method: 'POST', body: {}, timeoutMs: 180000 }); }
    catch (e) { if (e instanceof SignedOutError) onSignedOut(); else setError(message(e)); }
    finally { lock.current = false; setBusy(false); reload(); }
  };
  const pr = view.pullRequest; const github = view.github; const working = busy || view.publishing; const failure = error || view.failure?.message;
  if (!pr) return <Card title="Pull request"><div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '12px', alignItems: 'flex-start' }}>
    {failure && <div class="note bad" role="alert">{failure}</div>}
    <button type="button" class="btn primary" disabled={working || !view.canPublish} onClick={() => void publish()}>{working ? 'Opening the pull request…' : failure ? 'Try again' : 'Open pull request'}</button>
  </div></Card>;
  const checks = github?.checks ?? []; const comments = github?.comments ?? []; const open = github?.state === 'open';
  const failed = checks.filter(c => c.status === 'failed').length; const running = checks.filter(c => c.status === 'running').length; const passed = checks.filter(c => c.status === 'passed').length;
  const counted = comments.filter(c => c.counts).length;
  return <>
    <Card title={`Pull request #${pr.number}`} right={<a class="btn small" href={pr.url} target="_blank" rel="noreferrer">View on GitHub</a>}>
      <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '10px', alignItems: 'flex-start' }}>
        <span style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          {github ? <Chip tone={TONES[github.status.code]}>{github.status.text.replace(/^./, c => c.toUpperCase())}</Chip> : <Chip tone="ok">✓ Opened</Chip>}
          {open && github?.draft && <Chip tone="neutral">Draft</Chip>}
        </span>
        <span class="muted wrap-anywhere" style={{ fontSize: '13.5px' }}><span class="mono">{pr.repository}</span> · <span class="mono">{pr.branch}</span> → <span class="mono">{github?.base ?? pr.base}</span> · opened {formatTime(pr.openedAt)}{github?.syncedAt ? ` · GitHub read ${formatTime(github.syncedAt)}` : ''}</span>
        {github?.error && <div class="note warn" role="alert">⚠ GitHub could not be read. {github.error}</div>}
      </div>
    </Card>
    {open && github?.syncedAt && <div class="pr-two">
      <Card title="GitHub checks" right={checks.length > 0 && <Chip tone={failed ? 'bad' : running ? 'run' : 'ok'}>{[failed && count(failed, 'failed'), running && count(running, 'running'), passed && count(passed, 'passed')].filter(Boolean).join(' · ') || 'None counted'}</Chip>}>
        {checks.length === 0 ? <div class="pr-none">No checks on this commit</div> : <ul class="pr-list">{checks.map(c => <li key={c.name} class={c.status === 'failed' ? 'pr-failed' : ''}>
          <span class={`pr-ico ${CHECK[c.status].tone}`} aria-hidden="true">{CHECK[c.status].icon}</span>
          <div style={{ minWidth: 0, flex: 1 }}><b class="wrap-anywhere">{c.url ? <a href={c.url} target="_blank" rel="noreferrer">{c.name}</a> : c.name}</b><div class="muted wrap-anywhere" style={{ fontSize: '13px' }}>{CHECK[c.status].label}{c.summary ? ` · ${c.summary}` : ''}</div></div>
        </li>)}</ul>}
      </Card>
      <Card title="GitHub review comments" right={comments.length > 0 && <Chip tone={counted ? 'warn' : 'neutral'}>{counted} open</Chip>}>
        {comments.length === 0 ? <div class="pr-none">No open comments</div> : <ul class="pr-list">{comments.map(c => <li key={c.id}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
              <span class="wrap-anywhere">{c.path ? <><b class="mono">{c.path}</b>{c.line ? <span class="muted"> line {c.line}</span> : null}</> : <b>General comment</b>}</span>
              <span style={{ display: 'flex', gap: '6px', alignItems: 'center' }}><span class="muted" style={{ fontSize: '13px' }}>@{c.author}</span>{!c.counts && <Chip tone="neutral">Does not count</Chip>}</span>
            </div>
            <div class="pr-quote wrap-anywhere">{c.body}</div>
          </div>
        </li>)}</ul>}
      </Card>
    </div>}
  </>;
}
