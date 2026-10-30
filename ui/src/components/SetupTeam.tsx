import { useRef, useState } from 'preact/hooks';
import { api, resources, type TeamDetail, type TeamMember } from '../api';
import { usePoll } from '../state';
import { Card } from './ui';
export function SetupTeam() {
  const projects = usePoll(resources.projects.key, resources.projects.load, resources.projects.intervalMs);
  const teams = usePoll(resources.teams.key, resources.teams.load, resources.teams.intervalMs);
  const [selected, setSelected] = useState(''); const [busy, setBusy] = useState(false); const lock = useRef(false); const [message, setMessage] = useState('');
  const project = projects.data?.find(p => p.id === selected) ?? (projects.data?.length === 1 ? projects.data[0] : undefined);
  const ready = teams.data?.find(t => !t.archived && t.readiness.ready && t.name === 'Development team');
  const save = async () => {
    if (lock.current || !project) return; lock.current = true; setBusy(true); setMessage('');
    try {
      let id = ready?.id;
      if (!id) {
        const templates = await api<TeamMember[]>('/teams/templates');
        const members = ['tech-lead', 'general-developer', 'qa-engineer', 'code-reviewer'].map(id => templates.find(t => t.id === id));
        if (members.some(m => !m)) throw new Error('Recommended roles are unavailable. Create a team in Teams.');
        const team = await api<TeamDetail>('/teams', { method: 'POST', body: { name: 'Development team', description: 'Plans, implements, tests and independently reviews changes.', members } });
        if (!team.readiness.ready) throw new Error('The team was saved as a draft. Check its readiness in Teams.');
        id = team.id;
      }
      await api(`/projects/${project.id}/default-team`, { method: 'PUT', body: { teamId: id, expectedVersion: project.version } });
      setMessage(`Development team selected for ${project.id}.`);
    } catch (e) { setMessage(`${e instanceof Error ? e.message : 'Could not save the team.'} Check Teams and project defaults before retrying.`); }
    finally { lock.current = false; setBusy(false); teams.reload(); projects.reload(); }
  };
  return <Card title="3 · Choose your team"><div class="form-stack"><span>Start with a Tech Lead, Developer, QA Engineer and independent Code Reviewer. You can edit their roles later.</span>{projects.data && projects.data.length > 1 && <label class="field">Project for this team<select value={selected} disabled={busy} onChange={e => setSelected(e.currentTarget.value)}><option value="">Choose a project</option>{projects.data.map(p => <option value={p.id}>{p.id}</option>)}</select></label>}<button class="btn primary" disabled={busy || !project || !teams.data} onClick={() => void save()}>{busy ? 'Saving…' : 'Use recommended team'}</button>{message && <div role="status" class="note info">{message}</div>}<a href="/ui/teams">Choose or customize another team</a></div></Card>;
}
