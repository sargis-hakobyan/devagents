import { useRef, useState } from 'preact/hooks';
import { api, resources, SignedOutError, type Project, type ProjectSkills } from '../api';
import { ProjectIntegrations } from '../components/Integrations';
import { Card, Chip, ErrorNote, Skeleton } from '../components/ui';
import { formatTime } from '../format';
import { onSignedOut, retryNow, usePoll } from '../state';

const useAllProjects = () => usePoll(resources.projectsAll.key, resources.projectsAll.load, resources.projectsAll.intervalMs);
/** One change to a project under the version on screen; every project list refreshes afterwards. */
function useProjectAction() {
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const lock = useRef(false);
  const run = async (work: () => Promise<unknown>): Promise<boolean> => {
    if (lock.current) return false; lock.current = true; setBusy(true); setError('');
    try { await work(); return true; }
    catch (e) { if (e instanceof SignedOutError) onSignedOut(); else setError(e instanceof Error ? e.message : String(e)); return false; }
    finally { lock.current = false; setBusy(false); retryNow(); }
  };
  return { busy, error, run };
}
const setArchived = (project: Project, archived: boolean) => api(`/projects/${encodeURIComponent(project.id)}/archive`, { method: 'POST', body: { archived, expectedVersion: project.version } });

/** A task's project by name, linked to its page and marked when the project is archived. */
export function ProjectRef({ id, name, archived }: { id: string; name: string; archived: boolean }) {
  return <><a href={`/ui/projects/${encodeURIComponent(id)}`} style={{ fontWeight: 600 }}>{name}</a>{archived && <> <Chip tone="neutral">Archived project</Chip></>}</>;
}
function RestoreButton({ project, primary }: { project: Project; primary?: boolean }) {
  const action = useProjectAction();
  return <span style={{ display: 'flex', flexDirection: 'column', gap: '6px', alignItems: 'flex-start', minWidth: 0 }}>
    <button type="button" class={`btn small${primary ? ' primary' : ''}`} disabled={action.busy} aria-label={`Restore ${project.name}`} onClick={() => void action.run(() => setArchived(project, false))}>{action.busy ? 'Restoring…' : 'Restore'}</button>
    {action.error && <span class="note bad" role="alert" style={{ fontSize: '12.5px' }}>{action.error}</span>}
  </span>;
}
/** Listed under the active projects: history stays reachable and a project can be brought back. */
export function ArchivedProjects() {
  const archived = useAllProjects().data?.filter(p => p.archivedAt) ?? [];
  if (archived.length === 0) return null;
  return <Card title={`Archived projects · ${archived.length}`}><div style={{ padding: '6px 16px 12px' }}>
    <p class="muted" style={{ fontSize: '13px', margin: '8px 0' }}>An archived project keeps its tasks, takes no new work and has no connections. Its folder can be registered again as a new project. Restoring is possible while no active project uses the folder.</p>
    {archived.map(p => <div key={p.id} style={{ display: 'flex', gap: '10px 16px', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', padding: '10px 0', borderTop: '1px solid var(--row)' }}>
      <div style={{ minWidth: 0 }}><a href={`/ui/projects/${encodeURIComponent(p.id)}`} style={{ fontWeight: 700 }}>{p.name}</a> <span class="muted" style={{ fontSize: '13px' }}>· archived {formatTime(p.archivedAt)}</span><div class="mono muted wrap-anywhere">{p.hostPath ?? p.path}</div></div>
      <RestoreButton project={p} />
    </div>)}
  </div></Card>;
}
/** The name is what people see; changing it touches nothing else. */
function ProjectName({ project }: { project: Project }) {
  const action = useProjectAction(); const [draft, setDraft] = useState<string>();
  const clean = (draft ?? '').trim();
  const invalid = draft !== undefined && (!clean ? 'Enter a name.' : clean.length > 80 ? 'Keep the name to 80 characters or fewer.' : '');
  const save = async (event: Event) => {
    event.preventDefault(); if (draft === undefined || invalid) return;
    if (clean === project.name) { setDraft(undefined); return; }
    if (await action.run(() => api(`/projects/${encodeURIComponent(project.id)}/name`, { method: 'PUT', body: { name: clean, expectedVersion: project.version } }))) setDraft(undefined);
  };
  if (draft === undefined) return <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}><h1 class="wrap-anywhere">{project.name}</h1><button type="button" class="btn small" onClick={() => setDraft(project.name)}>Rename</button></div>;
  return <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '6px', maxWidth: '560px' }}>
    <label class="field">Project name<input type="text" required maxLength={80} value={draft} disabled={action.busy} aria-invalid={invalid ? true : undefined} autoFocus onInput={e => setDraft(e.currentTarget.value)} /></label>
    <span class="hint">Shown on Projects, in the task list and wherever a project is chosen. The project's ID, history and folder do not change.</span>
    {(invalid || action.error) && <span class="note bad" role="alert" style={{ fontSize: '13px' }}>{invalid || action.error}</span>}
    <span style={{ display: 'flex', gap: '8px' }}><button type="submit" class="btn small primary" disabled={action.busy || Boolean(invalid)}>{action.busy ? 'Saving…' : 'Save name'}</button><button type="button" class="btn small" disabled={action.busy} onClick={() => setDraft(undefined)}>Cancel</button></span>
  </form>;
}
function ArchiveProject({ project }: { project: Project }) {
  const action = useProjectAction(); const [asking, setAsking] = useState(false);
  return <Card title="Archive this project"><div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '10px', alignItems: 'flex-start' }}>
    <span style={{ fontSize: '13.5px' }}>Take <b>{project.name}</b> out of use, for example to register the same repository again with another configuration. Its tasks, plans and results stay in Tasks, and it can be restored later. To change only the name, use Rename above.</span>
    {!asking ? <button type="button" class="btn" disabled={action.busy} onClick={() => setAsking(true)}>Archive project…</button> : <div role="group" aria-label={`Archive ${project.name}?`} style={{ display: 'flex', flexDirection: 'column', gap: '10px', alignItems: 'flex-start' }}>
      <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '13.5px' }}>
        <li><b>Kept:</b> every task with its plan, activity and result, and the task branches in your repository.</li>
        <li><b>Removed:</b> its GitHub and Jira connections. A token shared with another project stays saved.</li>
        <li><b>Stops:</b> new tasks for this project. Open tasks must be finished or cancelled first.</li>
      </ul>
      <span style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}><button type="button" class="btn primary" disabled={action.busy} onClick={() => void action.run(() => setArchived(project, true))}>{action.busy ? 'Archiving…' : `Yes, archive ${project.name}`}</button><button type="button" class="btn" disabled={action.busy} onClick={() => setAsking(false)}>Keep it</button></span>
    </div>}
    {action.error && <div class="note bad" role="alert">{action.error}</div>}
  </div></Card>;
}

/** One project: its name, where it lives, what it is connected to, and how to take it out of use. */
/** Read-only: skills are kept and edited in the project's repository, never here. */
function ProjectSkillsCard({ projectId }: { projectId: string }) {
  const found = usePoll(`project-skills:${projectId}`, () => api<ProjectSkills>(`/projects/${projectId}/skills`), 60000);
  const skills = found.data?.skills ?? [];
  return <Card title={found.data && !found.data.error ? `Skills · ${skills.length}` : 'Skills'}><div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
    {!found.data ? (found.error ? <ErrorNote message={found.error} /> : <Skeleton rows={2} label="Loading skills" />)
      : found.data.error ? <div class="note warn" role="alert">⚠ <b>Skills could not be read.</b> {found.data.error} Tasks run without them until this is fixed.</div>
      : skills.length === 0 ? <span style={{ fontSize: '13.5px' }}><b>No skills found.</b> Team members work from their role instructions and the task request only.</span>
      : <ul class="skill-list">{skills.map(s => <li key={s.path}><b class="wrap-anywhere">{s.name}</b><span class="muted wrap-anywhere">{s.description}</span></li>)}</ul>}
    <span class="hint">Skills live in the project's repository: one folder per skill in <span class="mono">.agents/skills/</span> with a <span class="mono">SKILL.md</span>. Every team member is told about the ones committed on <span class="mono">main</span> and reads those that match its work. Add or change them in the repository, not here.</span>
  </div></Card>;
}

export function ProjectPage({ id }: { id: string }) {
  const projects = useAllProjects();
  const status = usePoll(resources.status.key, resources.status.load, resources.status.intervalMs).data;
  if (!projects.data) return projects.error ? <ErrorNote message={projects.error} /> : <Skeleton rows={4} label="Loading project" />;
  const project = projects.data.find(p => p.id === id);
  if (!project) return <div class="note info">There is no project with the ID <span class="mono">{id}</span>. <a href="/ui/projects">Back to projects</a></div>;
  const docker = status?.service.dataDir === '/data';
  return <>
    <div class="page-head"><div style={{ minWidth: 0 }}>
      <a href="/ui/projects" style={{ fontWeight: 700, fontSize: '13px', textDecoration: 'none' }}>← Projects</a>
      <ProjectName key={project.id} project={project} />
      <p>{project.archivedAt ? <Chip tone="neutral">Archived</Chip> : <Chip tone="neutral">{docker && !project.hostPath ? 'Folder inside Docker' : 'Local folder'}</Chip>} <span class="mono wrap-anywhere">{project.hostPath ?? project.path}</span></p>
      <p style={{ fontSize: '12.5px' }}>Project ID <span class="mono wrap-anywhere">{project.id}</span>{project.hostPath && <> · inside Docker <span class="mono wrap-anywhere">{project.path}</span></>}</p>
    </div></div>
    {project.archivedAt ? <Card title="This project is archived"><div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '10px', alignItems: 'flex-start' }}>
      <span style={{ fontSize: '13.5px' }}>Archived {formatTime(project.archivedAt)}. Its tasks stay in <a href="/ui/tasks">Tasks</a> with their plans, activity and results. It takes no new work and has no connections, and its folder can be registered again as a new project.</span>
      <span style={{ fontSize: '13.5px' }} class="muted">Restoring brings it back as it was, without its GitHub and Jira connections. It is refused while an active project uses the same folder.</span>
      <RestoreButton project={project} primary />
    </div></Card> : <>
      <ProjectIntegrations projectId={project.id} />
      <ProjectSkillsCard projectId={project.id} />
      <ArchiveProject project={project} />
    </>}
  </>;
}
