import { useRef, useState } from 'preact/hooks';
import { api, resources, SignedOutError, type Project } from '../api';
import { Card, ErrorNote, Skeleton } from '../components/ui';
import { onSignedOut, retryNow, usePoll } from '../state';

export function CopyCommand({ command }: { command: string }) {
  const [note, setNote] = useState('');
  return <div class="command"><pre class="evidence">{command}</pre><button type="button" class="btn small" onClick={() => { void navigator.clipboard.writeText(command).then(() => setNote('Copied'), () => setNote('Select and copy the command above')); }}>Copy command</button><span aria-live="polite">{note}</span></div>;
}
export function RegisterProjectPage() {
  const [id, setId] = useState(''); const [path, setPath] = useState('');
  const [mode, setMode] = useState(''); const [busy, setBusy] = useState(false); const lock = useRef(false);
  const [error, setError] = useState(''); const [saved, setSaved] = useState<Project>();
  const [touched, setTouched] = useState({ id: false, path: false });
  const status = usePoll(resources.status.key, resources.status.load, resources.status.intervalMs);
  const docker = status.data?.service.dataDir === '/data';
  const [alreadyMounted, setAlreadyMounted] = useState(false);
  const [command, setCommand] = useState('');
  const hostSetup = docker && !alreadyMounted;
  const pathLabel = hostSetup ? 'Repository folder on your computer' : docker ? 'Repository path inside Docker' : 'Absolute path as the service sees it';
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const switchLocation = (mounted: boolean) => { setAlreadyMounted(mounted); setPath(''); setCommand(''); setError(''); setTouched(t => ({ ...t, path: false })); };
  const idError = !id ? 'Enter a project ID, for example my-project.'
    : id.length > 64 ? 'Keep the project ID to 64 characters or fewer.'
    : !/^[a-z][a-z0-9-]*$/.test(id) ? 'Start with a lowercase letter. Use only lowercase letters, digits and dashes; no spaces or underscores.' : '';
  const pathError = !path ? 'Enter the absolute path to your Git repository.'
    : path.startsWith('~') ? 'Expand ~ to the full absolute path, starting with /.'
    : !path.startsWith('/') ? 'An absolute path must start with /.'
    : /[\x00-\x1f\x7f]/.test(path) ? 'Remove line breaks or other control characters from the path.'
    : hostSetup && path.includes(',') ? 'The Docker launcher does not support commas in folder paths. Choose a folder without commas.'
    : path.split('/').includes('..') ? 'Use the full repository path without .. segments.'
    : /^\/+$/.test(path) ? 'Choose a Git repository folder, not the filesystem root /.' : '';
  const valid = !idError && !pathError;
  const showIdError = Boolean(idError && (id || touched.id));
  const showPathError = Boolean(pathError && (path || touched.path));
  const suggestedId = id.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
  const canSuggest = idError && suggestedId !== id && /^[a-z][a-z0-9-]{0,63}$/.test(suggestedId);
  const hostPath = docker && !hostSetup && /^\/(Users|home)\//.test(path);
  const formHint = hostSetup ? (!valid ? 'Enter a valid Project ID and the absolute folder path on your computer to prepare setup.' : 'Ready to prepare the command. Your folder will be checked when you run it on your computer.') : !id && !path ? 'Enter a Project ID and an absolute path to enable registration.'
    : !id ? 'Enter a Project ID to enable registration.' : !path ? 'Enter an absolute path to enable registration.'
    : !valid ? 'Fix the highlighted fields to enable registration.' : 'Ready to submit. The service will check the folder, Git repository and local main branch.';
  const submit = async (e: Event) => {
    e.preventDefault(); if (lock.current) return;
    if (!valid) { setTouched({ id: true, path: true }); return; }
    if (hostSetup) { setCommand(`./devagents project add --name ${quote(id)} --path ${quote(path)}`); return; }
    lock.current = true; setBusy(true); setError('');
    try { setSaved(await api<Project>('/projects', { method: 'POST', body: { id, path, ...(mode ? { defaultMode: mode } : {}) } })); retryNow(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); if (e instanceof SignedOutError) onSignedOut(); }
    finally { lock.current = false; setBusy(false); }
  };
  if (!status.data) return status.error ? <ErrorNote message={status.error} /> : <Skeleton rows={4} label="Loading project setup" />;
  return <>
    <div class="page-head"><div><div class="h">Projects</div><h1>Register a repository</h1><p>{docker ? 'Add an existing Git repository from your computer. The launcher handles its Docker path for you.' : 'Choose an existing Git repository by its absolute path. Work happens in managed worktrees.'}</p></div><a class="btn" href="/ui/projects">← All projects</a></div>
    {saved ? <Card title="Repository registered"><div class="form-stack"><b>{saved.id}</b><span class="hint">{docker ? 'Repository path inside Docker' : 'Repository folder'}</span><span class="mono wrap-anywhere">{saved.path}</span><span>Base commit <code>{saved.baseSha}</code></span><a class="btn primary" href={`/ui/tasks/new?project=${encodeURIComponent(saved.id)}`}>Submit work</a></div></Card> : <div class="workflow-grid">
      <Card title={hostSetup ? '1. Choose your repository' : 'Register an accessible repository'}>
        {docker && <div class="form-stack" style={{ paddingBottom: 0 }}>
          <label><input type="radio" name="project-location" disabled={busy} checked={!alreadyMounted} onChange={() => switchLocation(false)} /> Folder on my computer (recommended)</label>
          <label><input type="radio" name="project-location" disabled={busy} checked={alreadyMounted} onChange={() => switchLocation(true)} /> Already mounted in Docker (advanced)</label>
        </div>}
        <form class="form-stack" noValidate onSubmit={submit}>
        {error && <div class="note bad" role="alert">{error}</div>}
        <fieldset class="plain form-stack" disabled={busy}>
          <div class="field">
            <label for="project-id">Project ID</label>
            <input id="project-id" aria-label="Project ID" required maxLength={64} value={id} placeholder="my-project" autoCapitalize="none" spellcheck={false}
              aria-invalid={showIdError || undefined} aria-describedby={`project-id-hint${showIdError ? ' project-id-error' : ''}`}
              onBlur={() => setTouched(t => ({ ...t, id: true }))} onInput={e => { setId(e.currentTarget.value); setError(''); setCommand(''); }} />
            <span id="project-id-hint" class="hint">Lowercase letters, digits and dashes; start with a letter. Up to 64 characters, for example my-project.</span>
            <span id="project-id-error" aria-live="polite">{showIdError && <span class="note bad" style={{ display: 'block' }}>{idError}</span>}</span>
            {canSuggest && <button type="button" class="btn small" style={{ alignSelf: 'flex-start', maxWidth: '100%', overflowWrap: 'anywhere', textAlign: 'left' }} onClick={() => { setId(suggestedId); setError(''); setCommand(''); }}>Use “{suggestedId}”</button>}
          </div>
          <div class="field">
            <label for="project-path">{pathLabel}</label>
            <input id="project-path" aria-label={pathLabel} required value={path} placeholder={hostSetup ? '/Users/you/Projects/my-project' : docker ? '/projects/my-project' : '/absolute/path/to/my-project'} autoCapitalize="none" spellcheck={false}
              aria-invalid={showPathError || undefined} aria-describedby={`project-path-hint${showPathError ? ' project-path-error' : ''}${hostPath ? ' project-path-docker' : ''}`}
              onBlur={() => setTouched(t => ({ ...t, path: true }))} onInput={e => { setPath(e.currentTarget.value); setError(''); setCommand(''); }} />
            <span id="project-path-hint" class="hint">{hostSetup ? 'Paste the full folder path from your computer. Spaces are allowed. You do not need to move it into /projects.' : docker ? 'Only for a folder you have already mounted. Enter its destination inside Docker; it does not have to start with /projects.' : 'Use the full path to the Git checkout, starting with /. Spaces in folder names are allowed.'}</span>
            <span id="project-path-error" aria-live="polite">{showPathError && <span class="note bad" style={{ display: 'block' }}>{pathError}</span>}</span>
            {hostPath && <span id="project-path-docker" class="note warn">This looks like a folder on your computer. Docker can only use it if it is mounted at this exact path. Select “Folder on my computer” to let the launcher create the mapping.</span>}
          </div>
          {!hostSetup && <label class="field">Default autonomy<select value={mode} onChange={e => setMode(e.currentTarget.value)}><option value="">None · use service default, otherwise ask once</option><option value="plan-approval">Plan approval</option><option value="autonomous">Autonomous</option></select></label>}
          <div id="project-form-hint" class="hint" role="status">{busy ? 'Checking the repository…' : formHint}</div>
          <button class="btn primary" aria-describedby="project-form-hint" disabled={!valid || busy} type="submit">{hostSetup ? 'Prepare setup command' : busy ? 'Registering…' : 'Register project'}</button>
        </fieldset>
      </form></Card>
      <Card title={hostSetup ? '2. Connect the folder' : 'Before you register'}><div class="form-stack">
        {hostSetup ? <>
          <span>Docker cannot access a new folder until it is shared. Prepare the command, then run it in a terminal from your DevAgents folder.</span>
          {command ? <>
            <CopyCommand key={command} command={command} />
            <div class="note warn" role="status">Setup prepared · project not registered yet. Run the command to continue.</div>
            <span>The launcher checks your folder, asks you to confirm the mount, registers it and opens a fresh browser session.</span>
            <details><summary>How the folder will be connected</summary><dl class="kv" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
              <dt>On your computer</dt><dd class="mono wrap-anywhere">{path}</dd>
              <dt>Inside Docker (generated automatically)</dt><dd class="mono wrap-anywhere">/projects/{id}</dd>
            </dl><p>Both paths refer to the same files. Your original repository stays where it is.</p></details>
          </> : <span class="hint">Your setup command will appear here after you enter the project details.</span>}
          <span class="hint">Finish active tasks before applying the mount: it restarts DevAgents. New projects start with plan approval; you can change this later.</span>
        </> : <span>{docker ? 'Use the destination path from your existing Docker mount. For a new folder, select “Folder on my computer” above.' : 'The folder must be accessible to the running DevAgents service.'}</span>}
        <span class="hint">Choose the Git repository root. It needs a local <code>main</code> branch with at least one commit.</span>
      </div></Card>
    </div>}
  </>;
}
