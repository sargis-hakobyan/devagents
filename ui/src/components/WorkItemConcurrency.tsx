import { useState } from 'preact/hooks';
import { api, resources } from '../api';
import { usePoll } from '../state';
import { Card, ErrorNote, Skeleton } from './ui';

type Settings = { concurrency: number; version: number };
const load = () => api<Settings>('/settings/work-item-concurrency');
export function WorkItemConcurrency() {
  const settings = usePoll('work-item-concurrency', load, 5000);
  const status = usePoll(resources.status.key, resources.status.load, resources.status.intervalMs);
  const [draft, setDraft] = useState<{ value: string; version: number }>();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ error: boolean; text: string }>();
  const value = draft?.value ?? String(settings.data?.concurrency ?? '');
  const valid = /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 8;
  const save = async (event: Event) => {
    event.preventDefault(); if (!settings.data || !valid || busy) return;
    setBusy(true); setNote(undefined);
    try {
      await api('/settings/work-item-concurrency', { method: 'PUT', body: { concurrency: Number(value), expectedVersion: draft?.version ?? settings.data.version } });
      setDraft(undefined); settings.reload(); status.reload();
      setNote({ error: false, text: 'Subtask concurrency saved. Applies when tasks begin execution; running tasks keep their current limit.' });
    } catch (error) { setNote({ error: true, text: error instanceof Error ? error.message : String(error) }); settings.reload(); setDraft(undefined); }
    finally { setBusy(false); }
  };
  return <Card title="Parallel subtasks per task"><div style={{ padding: '14px 16px' }}>
    {settings.error && <ErrorNote message={settings.error} />}
    {!settings.data ? <><Skeleton rows={2} label="Loading subtask concurrency" /><button class="btn" onClick={settings.reload}>Retry</button></> : <form class="form-stack" onSubmit={save}>
      <div class="field"><label for="work-item-concurrency">Maximum parallel subtasks per task (1–8)</label>
      <input id="work-item-concurrency" type="number" min="1" max="8" step="1" required value={value} disabled={busy}
        style={{ maxWidth: '160px' }} onInput={e => { setDraft({ value: e.currentTarget.value, version: draft?.version ?? settings.data!.version }); setNote(undefined); }} /></div>
      <span class="hint">Each task starts another eligible subtask as soon as a reviewed result is integrated and a slot is free. Dependencies wait until their required changes are integrated.</span>
      <span class="hint">Saved across restarts and overrides the startup subtask limit. Applies when a task begins execution; running tasks keep their current limit. Agent, storage and shared operation limits still apply.</span>
      <div><button class="btn primary" type="submit" disabled={busy || !valid || Number(value) === settings.data.concurrency}>{busy ? 'Saving…' : 'Save subtask concurrency'}</button></div>
      {note && <div class={`note ${note.error ? 'bad' : 'info'}`} role={note.error ? 'alert' : 'status'}>{note.text}</div>}
    </form>}
  </div></Card>;
}
