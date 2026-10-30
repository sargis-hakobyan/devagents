import { resources } from '../api';
import { Card, ErrorNote, Skeleton } from '../components/ui';
import { usePoll } from '../state';
import { CopyCommand } from './RegisterProject';
import { SetupConnection } from '../components/SetupConnection';
import { SetupTeam } from '../components/SetupTeam';
export function SetupPage() {
  const status = usePoll(resources.status.key, resources.status.load, resources.status.intervalMs);
  const projects = usePoll(resources.projects.key, resources.projects.load, resources.projects.intervalMs);
  if (!status.data) return status.error ? <ErrorNote message={status.error} /> : <Skeleton label="Loading setup status" />;
  return <>
    <div class="page-head"><div><div class="h">Settings · setup</div><h1>Get ready to run work</h1><p>Connect a provider, add your project and choose a team.</p></div><a class="btn" href="/ui/settings">All settings</a></div>
    <SetupConnection locked={status.data.codex.vaultLocked} installed={status.data.codex.installed} />
    <Card title="2 · Add your project"><div class="form-stack"><span>{projects.data ? `${projects.data.length} registered repositories` : 'Project count unavailable'}</span><p>Using Docker? Return to the terminal where you started DevAgents and choose Add a project. Enter the checkout folder on your computer; the launcher handles mounting and registration.</p><CopyCommand command="./devagents project add" /><span>Adding a mount restarts the service. Finish sign-in and any active work first. The launcher opens a fresh browser link afterwards.</span><a href="/ui/projects/new">Native service or already-mounted folder? Register it here</a></div></Card>
    <SetupTeam />
    <Card title="4 · Start your first task"><div class="form-stack"><span>Describe the change and what success looks like. Choose plan approval if you want to review the plan before work starts.</span><div class="note info">A saved connection does not prove model access or available quota. No paid test runs automatically.</div><button class="btn" disabled title="Use the optional, explicitly chosen terminal test">Test connection · terminal only</button><a class="btn primary" href="/ui/tasks/new">Submit work</a></div></Card>
  </>;
}
