import { useEffect, useRef, useState } from 'preact/hooks';
import { api, ApiError, SignedOutError, resources, teamLabel, type Task } from '../api';
import { Card, ErrorNote, Skeleton } from '../components/ui';
import { onSignedOut, useConnection, usePoll } from '../state';

import { readAttempt, saveAttempt, clearAttempt, type Attempt, type Payload } from '../attempt';
export function SubmitTaskPage() {
  const projects = usePoll(resources.projects.key, resources.projects.load, resources.projects.intervalMs);
  const teams = usePoll(resources.teams.key, resources.teams.load, resources.teams.intervalMs);
  const defaults = usePoll('submission-options', () => api<{ projects: { projectId: string; mode: string | null; source: string }[] }>('/submission-options'), 10000);
  const status = usePoll(resources.status.key, resources.status.load, resources.status.intervalMs);
  const connection = useConnection(); const lock = useRef(false); const edited = useRef(false);
  const [restored] = useState(() => { try { return { attempt: readAttempt(), error: '' }; } catch (e) { return { attempt: undefined, error: `Cannot restore the attempt: ${e instanceof Error ? e.message : String(e)}` }; } });
  const [storageError, setStorageError] = useState(restored.error);
  const [projectId, setProject] = useState(new URLSearchParams(location.search).get('project') ?? '');
  const [request, setRequest] = useState(''); const [criteria, setCriteria] = useState<string[]>([]);
  const [teamId, setTeam] = useState(''); const [mode, setMode] = useState('');
  const [attempt, setAttempt] = useState<Attempt | undefined>(restored.attempt); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [accepted, setAccepted] = useState<Task>(); const [abandon, setAbandon] = useState(false);
  useEffect(() => {
    const from = new URLSearchParams(location.search).get('from');
    if (restored.attempt) { const p = restored.attempt.payload; setProject(p.projectId); setRequest(p.request); setCriteria(p.acceptanceCriteria); setTeam(p.teamId ?? ''); setMode(p.mode ?? ''); return; }
    if (from && /^[a-f0-9-]{36}$/.test(from)) void api<Task>(`/tasks/${from}`).then(t => { if (!edited.current) { setRequest(t.request); setCriteria(t.acceptanceCriteria); } }, e => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  const project = projects.data?.find(p => p.id === projectId);
  const chosen = teams.data?.find(t => t.id === (teamId || project?.defaultTeamId));
  const inherited = teams.data?.find(t => t.id === project?.defaultTeamId);
  const effective = defaults.data?.projects.find(p => p.projectId === projectId);
  const unavailable = Boolean(chosen && (chosen.archived || !chosen.readiness.ready)) || Boolean((teamId || project?.defaultTeamId) && !chosen);
  const valid = Boolean(project && request.trim() && request.length <= 20000 && !unavailable && defaults.data && teams.data && !projects.error && !teams.error && !defaults.error);
  const send = async (retry?: Attempt) => {
    if (lock.current || storageError || (!retry && (!valid || attempt))) return;
    const next = retry ?? { key: crypto.randomUUID(), at: new Date().toISOString(), payload: { projectId, request, acceptanceCriteria: criteria.filter(x => x.trim()), ...(teamId ? { teamId } : {}), ...(mode ? { mode: mode as NonNullable<Payload['mode']> } : {}) } };
    try { saveAttempt(next); } catch { setStorageError('Cannot save the attempt in tab session storage. No request was sent. Enable session storage before submitting.'); return; }
    lock.current = true; setBusy(true); setError(''); setAttempt(next);
    try {
      const task = await api<Task>('/tasks', { method: 'POST', body: next.payload, idempotencyKey: next.key });
      if (!task?.id) throw new Error('The service response did not identify the created task.');
      clearAttempt(); setAccepted(task); setAttempt(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && ![401, 403, 408, 409].includes(e.status)) { clearAttempt(); setAttempt(undefined); }
      if (e instanceof ApiError && ['team_archived', 'team_not_ready', 'not_found'].includes(e.code)) { clearAttempt(); setAttempt(undefined); }
      if (e instanceof SignedOutError) onSignedOut();
    } finally { lock.current = false; setBusy(false); }
  };
  const clear = () => { try { clearAttempt(); } catch { setStorageError('Cannot clear tab storage. No new request will be sent.'); return; } setStorageError(''); setAttempt(undefined); setAbandon(false); setError(''); };
  if (accepted) return <Card title="Task accepted"><div class="form-stack"><b>{accepted.request}</b><span>{teamLabel(accepted.team)}</span><span>{accepted.mode ?? 'Waiting for a mode choice'} · snapshot from the service response</span><a class="btn primary" href={`/ui/tasks/${accepted.id}`}>Open task</a><button class="btn" onClick={() => { setAccepted(undefined); setRequest(''); setCriteria([]); setTeam(''); setMode(''); edited.current = true; }}>Submit another task</button></div></Card>;
  return <>
    <div class="page-head"><div><div class="h">Tasks</div><h1>Submit work</h1><p>Choose a project and tell the team what a successful result looks like. Do not include credentials or secrets.</p></div><a class="btn" href="/ui/tasks">← All tasks</a></div>
    {(!status.data?.codex.signedIn || !status.data?.codex.installed || status.data?.codex.vaultLocked) && <div class="note warn">Connection unavailable or not verified. You can submit, but planning may fail at preflight until setup is complete. <a href="/ui/settings/setup">Finish setup</a></div>}
    {!connection.online && <div class="note warn">Disconnected. You can keep typing; submission is disabled until reconnection. Lists show the last known state{connection.lastUpdate ? ` from ${connection.lastUpdate.toLocaleTimeString()}` : ''}.</div>}
    {storageError && <div class="note bad" role="alert">{storageError}<p>The first task may exist. Clearing this attempt does not cancel it.</p><button class="btn" onClick={clear}>Abandon stored attempt</button></div>}
    {error && <div class="note bad" role="alert">{error}</div>}
    {attempt && <Card title={busy ? 'Submitting…' : 'Unresolved attempt'} tone="warn"><div class="form-stack"><span>The first request may already have created a task. Retry uses exactly the same key and payload. Abandoning does not cancel any task.</span><details><summary>Show the payload</summary><pre class="evidence">{JSON.stringify(attempt.payload, null, 2)}</pre></details><div class="actions"><button class="btn primary" disabled={busy} onClick={() => void send(attempt)}>Retry this attempt</button><button class="btn" disabled={busy} onClick={() => setAbandon(true)}>Abandon attempt…</button></div>{abandon && <div class="note warn"><b>The first task may exist in your task list.</b><div class="actions"><button class="btn" onClick={clear}>Abandon</button><button class="btn" onClick={() => setAbandon(false)}>Keep</button></div></div>}</div></Card>}
    {(projects.error && !projects.data) || (teams.error && !teams.data) || (defaults.error && !defaults.data) ? <ErrorNote message={projects.error ?? teams.error ?? defaults.error!} /> : !projects.data || !teams.data || !defaults.data ? <Skeleton label="Loading submission choices" /> : <div class="workflow-grid">
      <Card title="New task"><form class="form-stack" onSubmit={e => { e.preventDefault(); void send(); }}><fieldset class="plain form-stack" disabled={busy || Boolean(attempt) || Boolean(storageError)}>
        <label class="field">Project<select aria-label="Project" required value={projectId} onChange={e => { setProject(e.currentTarget.value); setTeam(''); }}><option value="">Choose a registered project</option>{projects.data.map(p => <option key={p.id} value={p.id}>{p.id}</option>)}</select></label>
        {!projects.data.length && <a href="/ui/projects/new">Register a repository</a>}
        <label class="field">What should the team do?<textarea required rows={6} maxLength={20000} value={request} onInput={e => { edited.current = true; setRequest(e.currentTarget.value); }} /></label>
        <div class="form-stack"><b>Acceptance criteria</b>{criteria.map((c, i) => <div class="criterion-row" key={i}><label class="field">Criterion {i + 1}<input value={c} onInput={e => { edited.current = true; const value = e.currentTarget.value; setCriteria(cs => cs.map((v, n) => n === i ? value : v)); }} /></label><button class="btn small" type="button" aria-label={`Remove criterion ${i + 1}`} onClick={() => setCriteria(cs => cs.filter((_, n) => n !== i))}>Remove</button></div>)}<button class="btn" type="button" onClick={() => setCriteria(cs => [...cs, ''])}>Add criterion</button></div>
        <label class="field">Team<select aria-label="Team" value={teamId} onChange={e => setTeam(e.currentTarget.value)}><option value="" disabled={Boolean(project?.defaultTeamId && (!inherited || inherited.archived || !inherited.readiness.ready))}>{project?.defaultTeamId ? `Project default · ${teamLabel(teams.data.find(t => t.id === project.defaultTeamId))}` : 'Project default · legacy agent configuration'}</option>{teams.data.map(t => <option key={t.id} value={t.id} disabled={t.archived || !t.readiness.ready}>{teamLabel(t)}{t.archived ? ' · archived' : t.readiness.ready ? ' · ready' : ` · draft: ${t.readiness.diagnostics.find(d => d.level === 'error')?.message ?? 'not ready'}`}</option>)}</select></label>
        {unavailable && <div class="note warn">This team is unavailable. Choose a ready team or change the project default.</div>}
        <fieldset class="plain form-stack"><legend>Autonomy mode</legend>{[['', `Use default · ${effective?.mode ?? 'wait for a choice'} (${effective?.source ?? 'none'})`], ['plan-approval', 'Plan approval · wait for my approval'], ['autonomous', 'Autonomous · proceed within policy']].map(([value, label]) => <label class="choice"><input type="radio" name="mode" value={value} checked={mode === value} onChange={() => setMode(value!)} />{label}</label>)}</fieldset>
        <button class="btn primary submit-action" type="submit" disabled={!valid || !connection.online || busy || Boolean(attempt) || Boolean(storageError)}>Submit task</button>
      </fieldset></form></Card>
      <Card title="What will be submitted"><div class="form-stack"><b>{projectId || 'Choose a project'}</b><span>{teamLabel(chosen)} {chosen ? '(now)' : ''}</span><span>The service freezes the current team revision when it accepts the task. Edits afterwards do not affect it.</span><span>Mode: {mode || effective?.mode || 'Ask once after submission'}</span><span>Completion produces a reviewed local commit. It does not merge or push.</span></div></Card>
    </div>}
  </>;
}
