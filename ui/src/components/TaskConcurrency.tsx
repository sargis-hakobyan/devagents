import { useState } from 'preact/hooks';
import { api, resources } from '../api';
import { usePoll } from '../state';
import { Card, ErrorNote, Skeleton } from './ui';

type Settings = { maxConcurrentTasks: number; version: number };
const load = () => api<Settings>('/settings/task-concurrency');
export function TaskConcurrency() {
  const settings = usePoll('task-concurrency', load, 5000);
  const status = usePoll(resources.status.key, resources.status.load, resources.status.intervalMs);
  const [draft, setDraft] = useState<{ value: string; version: number }>();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ error: boolean; text: string }>();
  const value = draft?.value ?? String(settings.data?.maxConcurrentTasks ?? '');
  const valid = /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 8;
  const save = async (event: Event) => {
    event.preventDefault(); if (!settings.data || !valid || busy) return;
    setBusy(true); setNote(undefined);
    try {
      await api('/settings/task-concurrency', { method: 'PUT', body: { maxConcurrentTasks: Number(value), expectedVersion: draft?.version ?? settings.data.version } });
      setDraft(undefined); settings.reload(); status.reload();
      setNote({ error: false, text: 'Task concurrency saved. No restart needed.' });
    } catch (error) { setNote({ error: true, text: error instanceof Error ? error.message : String(error) }); settings.reload(); setDraft(undefined); }
    finally { setBusy(false); }
  };
  return <Card title="Parallel tasks"><div style={{ padding: '14px 16px' }}>
    {settings.error && <ErrorNote message={settings.error} />}
    {!settings.data ? <><Skeleton rows={2} label="Loading task concurrency" /><button class="btn" onClick={settings.reload}>Retry</button></> : <form class="form-stack" onSubmit={save}>
      <div class="field"><label for="task-concurrency">Maximum concurrent tasks (1–8)</label>
      <input id="task-concurrency" type="number" min="1" max="8" step="1" required value={value} disabled={busy}
        style={{ maxWidth: '160px' }} onInput={e => { setDraft({ value: e.currentTarget.value, version: draft?.version ?? settings.data!.version }); setNote(undefined); }} /></div>
      <span class="hint">Applies across all projects, including tickets on the same project. Increasing the limit allows queued tasks to start. Lowering it lets active tasks finish before more start.</span>
      <span class="hint">Saved across restarts and takes precedence over the startup task limit. Shared engine and validation operation limits still apply.</span>
      <div><button class="btn primary" type="submit" disabled={busy || !valid || Number(value) === settings.data.maxConcurrentTasks}>{busy ? 'Saving…' : 'Save task concurrency'}</button></div>
      {note && <div class={`note ${note.error ? 'bad' : 'info'}`} role={note.error ? 'alert' : 'status'}>{note.text}</div>}
    </form>}
  </div></Card>;
}
