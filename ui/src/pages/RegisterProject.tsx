import { useRef, useState } from 'preact/hooks';
import { api, SignedOutError, type Project } from '../api';
import { Card } from '../components/ui';
import { onSignedOut, retryNow } from '../state';

export function CopyCommand({ command }: { command: string }) {
  const [note, setNote] = useState('');
  return <div class="command"><pre class="evidence">{command}</pre><button type="button" class="btn small" onClick={() => { void navigator.clipboard.writeText(command).then(() => setNote('Copied'), () => setNote('Select and copy the command above')); }}>Copy command</button><span aria-live="polite">{note}</span></div>;
}
export function RegisterProjectPage() {
  const [id, setId] = useState(''); const [path, setPath] = useState('');
  const [mode, setMode] = useState(''); const [busy, setBusy] = useState(false); const lock = useRef(false);
  const [error, setError] = useState(''); const [saved, setSaved] = useState<Project>();
  const valid = /^[a-z][a-z0-9-]{0,63}$/.test(id) && path.startsWith('/') && !path.split('/').includes('..');
  const submit = async (e: Event) => {
    e.preventDefault(); if (lock.current || !valid) return;
    lock.current = true; setBusy(true); setError('');
    try { setSaved(await api<Project>('/projects', { method: 'POST', body: { id, path, ...(mode ? { defaultMode: mode } : {}) } })); retryNow(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); if (e instanceof SignedOutError) onSignedOut(); }
    finally { lock.current = false; setBusy(false); }
  };
  return <>
    <div class="page-head"><div><div class="h">Projects</div><h1>Register a repository</h1><p>Use the absolute path the service can see. Work happens in managed worktrees.</p></div><a class="btn" href="/ui/projects">← All projects</a></div>
    {saved ? <Card title="Repository registered"><div class="form-stack"><b>{saved.id}</b><span class="mono wrap-anywhere">{saved.path}</span><span>Base commit <code>{saved.baseSha}</code></span><a class="btn primary" href={`/ui/tasks/new?project=${encodeURIComponent(saved.id)}`}>Submit work</a></div></Card> : <div class="workflow-grid">
      <Card title="New project"><form class="form-stack" onSubmit={submit}>
        {error && <div class="note bad" role="alert">{error}</div>}
        <fieldset class="plain form-stack" disabled={busy}>
          <label class="field">Project ID<input aria-label="Project ID" required pattern="[a-z][a-z0-9-]{0,63}" maxLength={64} value={id} onInput={e => setId(e.currentTarget.value)} /><span class="hint">Lowercase letters, digits and dashes; start with a letter.</span></label>
          <label class="field">Absolute path as the service sees it<input aria-label="Absolute path as the service sees it" required value={path} onInput={e => setPath(e.currentTarget.value)} placeholder="/projects/website" /><span class="hint">Docker: use the mounted container path. Native: use the host path. No ~ or parent traversal.</span></label>
          <label class="field">Default autonomy<select value={mode} onChange={e => setMode(e.currentTarget.value)}><option value="">None · use service default, otherwise ask once</option><option value="plan-approval">Plan approval</option><option value="autonomous">Autonomous</option></select></label>
          <div class="note info">The service checks the Git root and records its base commit. It resolves symlinks to the canonical repository path.</div>
          <button class="btn primary" disabled={!valid || busy} type="submit">{busy ? 'Registering…' : 'Register project'}</button>
        </fieldset>
      </form></Card>
      <Card title="Docker: mount first, then register"><div class="form-stack">
        <span>1. Add an explicit project mount to <code>compose.override.yaml</code>. Replace the example host path with your checkout.</span>
        <CopyCommand command={'services:\n  devagents:\n    volumes:\n      - /absolute/host/path/website:/projects/website'} />
        <span>2. Restart to apply the mount. A restart ends the browser session.</span><CopyCommand command="./devagents start" />
        <span>3. Register <code>/projects/website</code> here. The host path is not the container path. Do not mount your home directory or the Docker socket.</span>
      </div></Card>
    </div>}
  </>;
}
