import { resources } from '../api';
import { Card, Chip, ErrorNote, Skeleton } from '../components/ui';
import { usePoll } from '../state';
import { CopyCommand } from './RegisterProject';
export function SetupPage() {
  const status = usePoll(resources.status.key, resources.status.load, resources.status.intervalMs);
  const projects = usePoll(resources.projects.key, resources.projects.load, resources.projects.intervalMs);
  const teams = usePoll(resources.teams.key, resources.teams.load, resources.teams.intervalMs);
  if (!status.data) return status.error ? <ErrorNote message={status.error} /> : <Skeleton label="Loading setup status" />;
  const c = status.data.codex; const ready = teams.data?.filter(t => !t.archived && t.readiness.ready).length;
  return <>
    <div class="page-head"><div><div class="h">Settings · setup</div><h1>Get ready to run work</h1><p>Availability comes from the service. Provider sign-in happens in your terminal; secrets never pass through this page.</p></div><a class="btn" href="/ui/settings">All settings</a></div>
    <Card title="1 · Browser session" right={<Chip tone="ok">✓ Signed in</Chip>}><div class="form-stack">This browser session is separate from provider sign-in. It ends after 12 hours idle, 24 hours total, or a service restart. Renew it with a one-time CLI link.</div></Card>
    <Card title="2 · Coding runtime" right={<Chip tone={c.installed ? 'ok' : 'bad'}>{c.installed ? '✓ Installed' : '✕ Not installed'}</Chip>}><div class="form-stack"><span>{c.version ?? 'Codex CLI unavailable'} · default engine: {status.data.defaults.engine}</span>{!c.installed && <><span>Docker includes the pinned runtime after building the image. Native installation:</span><CopyCommand command="npm install -g @openai/codex@0.160.1" /></>}<span>Claude execution is unavailable until M4. {status.data.claude.note}</span></div></Card>
    <Card title="3 · Saved provider sign-in" right={<Chip tone={c.signedIn && !c.vaultLocked ? 'ok' : 'warn'}>{c.vaultLocked ? 'Credentials locked' : c.signedIn ? 'Sign-in saved' : 'Not signed in'}</Chip>}><div class="form-stack">
      {c.vaultLocked && <div class="note warn">Encrypted credentials exist but are locked. Run the launcher to unlock them using the existing secure flow.</div>}
      <b>Docker launcher · run from the DevAgents checkout</b><CopyCommand command="./devagents start" />
      <span>After unlocking the vault, change sign-in inside the container:</span><CopyCommand command="docker compose exec devagents node dist/cli/main.js auth setup" />
      <b>Native terminal setup</b><CopyCommand command="npm run cli -- auth setup" />
      <span>These commands offer ChatGPT sign-in or an API key. Replacements use the same terminal flow; no saved secret is displayed here.</span>
    </div></Card>
    <Card title="4 · Model access" right={<Chip tone="warn">Not verified</Chip>}><div class="form-stack"><span>Saved sign-in does not prove quota or access to every agent model. A real task or an explicitly chosen terminal connection test uses your allowance. No paid test runs automatically.</span><button class="btn" disabled title="Use the optional, explicitly chosen terminal test">Test connection · terminal only</button></div></Card>
    <Card title="5 · Register a project"><div class="form-stack"><span>{projects.data ? `${projects.data.length} registered repositories` : 'Project count unavailable'}</span><span>Docker needs an explicit mount and its container path. Native registration uses the existing checkout's absolute host path.</span><a class="btn" href="/ui/projects/new">Register a repository</a></div></Card>
    <Card title="6 · Choose a team"><div class="form-stack"><span>{ready === undefined ? 'Team readiness unavailable' : `${ready} ready teams`}. Teams are optional; without a selected or project-default team, tasks use the legacy YAML agents.</span><a class="btn" href="/ui/teams">Manage teams</a></div></Card>
    <div class="note warn">You can prepare and submit a task before saving a sign-in. Planning may fail at preflight; after setup, submit a new task rather than expecting a failed one to resume.</div>
    <a class="btn primary" href="/ui/tasks/new">Submit work</a>
  </>;
}
