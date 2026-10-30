import { useRef, useState } from 'preact/hooks';
import { api, resources } from '../api';
import { usePoll } from '../state';
import { Card } from './ui';
import { STARTER_TEAM_ID } from '../../../src/domain/starter-team';
export function SetupTeam() {
  const projects = usePoll(resources.projects.key, resources.projects.load, resources.projects.intervalMs);
  const teams = usePoll(resources.teams.key, resources.teams.load, resources.teams.intervalMs);
  const [selected, setSelected] = useState(''); const [busy, setBusy] = useState(false); const lock = useRef(false); const [message, setMessage] = useState('');
  const project = projects.data?.find(p => p.id === selected) ?? (projects.data?.length === 1 ? projects.data[0] : undefined);
  const ready = teams.data?.find(t => !t.archived && t.readiness.ready && t.id === STARTER_TEAM_ID);
  const save = async () => {
    if (lock.current || !project) return; lock.current = true; setBusy(true); setMessage('');
    try {
      if (!ready) throw new Error('The starter team is unavailable. Check its readiness or choose another team in Teams.');
      const id = ready.id;
      await api(`/projects/${project.id}/default-team`, { method: 'PUT', body: { teamId: id, expectedVersion: project.version } });
      setMessage('Team selection saved.');
    } catch (e) { setMessage(`${e instanceof Error ? e.message : 'Could not save the team.'} Check Teams and project defaults before retrying.`); }
    finally { lock.current = false; setBusy(false); teams.reload(); projects.reload(); }
  };
  return <Card title="3 · Choose your team"><div class="form-stack"><span>New projects start with a Tech Lead, Developer, QA Engineer and independent Code Reviewer. You can edit their roles later.</span>{projects.data && projects.data.length > 1 && <label class="field">Project for this team<select value={selected} disabled={busy} onChange={e => setSelected(e.currentTarget.value)}><option value="">Choose a project</option>{projects.data.map(p => <option value={p.id}>{p.id}</option>)}</select></label>}{teams.data && !ready && <div class="note warn">The starter team is archived or not ready. Choose or update a team in Teams.</div>}<button class="btn primary" disabled={busy || !project || !ready || project.defaultTeamId === ready.id} onClick={() => void save()}>{busy ? 'Saving…' : 'Use recommended team'}</button>{project?.defaultTeamId && <div class="note info">{teams.data?.find(t => t.id === project.defaultTeamId)?.name ?? 'Saved team'} selected for {project.id}.</div>}{message && <div role="status" class="note info">{message}</div>}<a href="/ui/teams">Choose or customize another team</a></div></Card>;
}
