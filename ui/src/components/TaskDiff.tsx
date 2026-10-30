import { useEffect, useState } from 'preact/hooks';
import { api, SignedOutError } from '../api';
import { Card, Skeleton } from './ui';
import { onSignedOut } from '../state';
type File = { path: string; added: number | null; removed: number | null; state: string; text: string; shownBytes: number; bytes: number | null; redacted: boolean };
type Diff = { base: string; final: string; state: string; limits: { perFileBytes: number; totalBytes: number; files: number; readBytes: number }; files: File[] };
export function TaskDiff({ id }: { id: string }) {
  const [diff, setDiff] = useState<Diff>(); const [error, setError] = useState(''); const [selected, setSelected] = useState(0); const [retry, setRetry] = useState(0);
  useEffect(() => { let active = true; setDiff(undefined); setError(''); setSelected(0); void api<Diff>(`/tasks/${id}/diff`).then(d => { if (active) setDiff(d); }, e => { if (active) { setError(e instanceof Error ? e.message : String(e)); if (e instanceof SignedOutError) onSignedOut(); } }); return () => { active = false; }; }, [id, retry]);
  if (error) return <Card title="Diff unavailable"><div class="form-stack"><div role="alert">{error}</div><button class="btn" onClick={() => setRetry(n => n + 1)}>Retry diff</button></div></Card>;
  if (!diff) return <Skeleton label="Reading the diff…" />;
  const file = diff.files[selected];
  return <Card title="Read-only diff" right={<span class="chip neutral">{diff.state} · {diff.files.length} files</span>}><div class="form-stack">
    <div class="mono wrap-anywhere">Base {diff.base} → final {diff.final}</div>
    <div class="muted">Text only. Up to {diff.limits.perFileBytes / 1024} KiB per file, {diff.limits.totalBytes / 1024} KiB total and {diff.limits.files} files. Known secret values are redacted before truncation. Text exceeding the {diff.limits.readBytes / 1024} KiB read cap is omitted entirely.</div>
    {diff.state === 'empty' ? <div class="note info">Both commits exist. The final commit introduces no file changes relative to the recorded base.</div> : <div class="workflow-grid diff-grid"><nav aria-label="Changed files" class="stack">{diff.files.map((f, i) => <button class="btn diff-file" aria-current={selected === i ? 'true' : undefined} onClick={() => setSelected(i)}><span class="wrap-anywhere">{f.path}</span><span>{f.added === null ? 'binary' : `+${f.added} −${f.removed}`} · {f.state}</span></button>)}</nav>{file && <section aria-label="Selected file diff" class="stack"><b class="wrap-anywhere">{file.path}</b><span>{file.state}{file.redacted ? ' · secret values redacted' : ''}</span>{file.state === 'binary' ? <div class="note info">Binary content is not shown.</div> : file.state === 'withheld' ? <div class="note warn">Protected file content is withheld.</div> : <><span>{file.shownBytes} bytes shown{file.bytes === null ? ' · total not measured' : ` of ${file.bytes} redacted bytes`}</span>{file.state === 'truncated' && <div class="note warn">Truncated by the display or read limit. Inspect the recorded branch locally for the complete change.</div>}<pre class="evidence diff-text">{file.text}</pre></>}</section>}</div>}
    <button class="btn" disabled title="Patch download is not available in this increment">Download patch · unavailable</button>
  </div></Card>;
}
