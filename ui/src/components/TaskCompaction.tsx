import { useState } from 'preact/hooks';
import { api, type CompactionPreview, type Task } from '../api';
import { useConnection } from '../state';

const size = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
/** Preview and confirmation are task-bound; the browser never supplies filesystem paths. */
export function TaskCompaction({ task }: { task: Task }) {
  const [preview, setPreview] = useState<CompactionPreview>();
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [result, setResult] = useState('');
  const { online } = useConnection();
  if (!['completed', 'failed', 'cancelled'].includes(task.state)) return null;
  const load = async () => {
    setBusy(true); setError(''); setResult(''); setPreview(undefined);
    try { setPreview(await api<CompactionPreview>(`/tasks/${task.id}/compaction-preview`, { timeoutMs: 90000 })); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const compact = async () => {
    if (!preview || preview.taskId !== task.id) return;
    setBusy(true); setError('');
    try {
      const done = await api<{ removed: string[]; estimatedReclaimedBytes: number }>(`/tasks/${task.id}/compact`, { method: 'POST', body: { digest: preview.digest }, timeoutMs: 180000 });
      setResult(`Compacted ${done.removed.length} resource director${done.removed.length === 1 ? 'y' : 'ies'} (${size(done.estimatedReclaimedBytes)} estimated). Worktrees, source edits, branches and history are kept.`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setPreview(undefined); setBusy(false); }
  };
  return <div class="stack" style={{ padding: '12px 16px' }}>
    <div><button type="button" class="btn" disabled={busy || !online} onClick={() => void load()}>Preview task compaction</button></div>
    {busy && <span role="status">Inspecting or compacting task resources…</span>}
    {error && <div class="note warn" role="alert">{error} Request a fresh preview before trying again.</div>}
    {result && <div class="note info" role="status">{result}</div>}
    {preview?.taskId === task.id && <div class="note warn">
      <b>{preview.candidates.length ? `Remove regenerable resources · ${size(preview.reclaimableBytes)} estimated` : 'No eligible resource directories to compact'}</b>
      <p>Removes ignored node_modules and .pnpm-store directories, private tool caches and temporary run files owned by this task. Dependencies and tools must be prepared again before running checks in these worktrees.</p>
      {preview.candidates.length > 0 && <ul>{preview.candidates.map(c => <li class="wrap-anywhere" key={`${c.worktree}/${c.path}`}><code>{c.worktree}/{c.path}</code> · {size(c.bytes)}</li>)}</ul>}
      <ul>{preview.kept.map((text, i) => <li class="wrap-anywhere" key={i}>{text}</li>)}</ul>
      <div class="actions"><button type="button" class="btn" disabled={busy || !online || !preview.candidates.length} onClick={() => void compact()}>Confirm compaction</button><button type="button" class="btn" disabled={busy} onClick={() => setPreview(undefined)}>Keep everything</button></div>
    </div>}
  </div>;
}
