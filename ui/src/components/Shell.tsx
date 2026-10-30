import type { ComponentChildren } from 'preact';
import { useLocation } from 'preact-iso';
import { logout, resources } from '../api';
import { relative, attentionStates } from '../format';
import { retryNow, useConnection, useNow, usePoll } from '../state';

const Icon = ({ d }: { d: string }) => <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d={d} /></svg>;
const icons = {
  overview: 'M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z',
  tasks: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
  teams: 'M9 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-5-6.3',
  projects: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.8 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.8H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 2.8-1.2V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.8 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.8H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.2 2.8z',
};
export const Spark = ({ size = 22 }: { size?: number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="#FFB703" aria-hidden="true"><path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z" /></svg>;

export function Shell({ children, context }: { children: ComponentChildren; context?: { kicker: string; title: string } }) {
  const { path, route } = useLocation(); const connection = useConnection(); const now = useNow();
  const status = usePoll(resources.status.key, resources.status.load, resources.status.intervalMs).data;
  const overview = usePoll(resources.overview.key, resources.overview.load, resources.overview.intervalMs).data;
  const attention = overview ? overview.attention.filter(t => attentionStates.includes(t.state)).length : 0;
  const nav = [['/ui/', 'Overview', icons.overview], ['/ui/tasks', 'Tasks', icons.tasks], ['/ui/teams', 'Teams', icons.teams], ['/ui/projects', 'Projects', icons.projects], ['/ui/settings', 'Settings', icons.settings]] as const;
  const current = (href: string) => href === '/ui/' ? path === '/ui/' || path === '/ui' : path.startsWith(href);
  const codex = status?.codex;
  const retryIn = connection.nextRetryAt ? Math.max(0, Math.ceil((connection.nextRetryAt - now) / 1000)) : 0;
  return <div class="app">
    <header class="band">
      <div class="brand">
        <a class="brand-name" href="/ui/"><Spark />devagents</a>
        <div class="brand-sep" />
        <div class="brand-ctx"><small>{context?.kicker ?? 'Local workspace'}</small><span>{context?.title ?? (status ? `${status.service.host}:${status.service.port} · ${status.service.platform}` : '…')}</span></div>
      </div>
      <div class="band-right">
        <span class="chip" title={connection.lastUpdate ? `Last update ${connection.lastUpdate.toLocaleTimeString()}` : 'No update yet'}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={connection.online ? '#6EE7A8' : '#FFD166'} stroke-width="3" aria-hidden="true">{connection.online ? <path d="M20 6 9 17l-5-5" /> : <path d="M12 8v5M12 16h.01M4 4l16 16" />}</svg>
          {connection.online ? `Connected · updated ${connection.lastUpdate ? relative(connection.lastUpdate, now) : 'just now'}` : 'Disconnected'}
        </span>
        {codex && <span class="chip">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={codex.signedIn ? '#FFD166' : '#FF8A8A'} stroke-width="3" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></svg>
          {codex.vaultLocked ? 'Codex credentials locked' : codex.signedIn ? 'Codex signed in · model access not verified' : codex.installed ? 'Codex not signed in' : 'Codex not installed'}
        </span>}
        <button type="button" class="btn" onClick={() => { void logout().finally(() => route('/ui/signed-out')); }}>Sign out</button>
      </div>
    </header>
    {status?.fixture && <div class="banner fixture" role="note"><span><b>Development fixture.</b> {status.fixture.label}</span></div>}
    {!connection.online && <div class="banner" role="status">
      <span><b>Service disconnected</b> · last update {connection.lastUpdate ? connection.lastUpdate.toLocaleTimeString() : 'none'} · retrying in {retryIn} s (attempt {connection.attempt}) · showing the last known state, nothing is invented</span>
      <button type="button" class="btn" onClick={retryNow}>Retry now</button>
    </div>}
    <div class="body">
      <nav class="nav" aria-label="Main">
        {nav.map(([href, label, d]) => <a key={href} href={href} aria-current={current(href) ? 'page' : undefined}><Icon d={d} />{label}{label === 'Tasks' && attention > 0 && <span class="badge" aria-label={`${attention} need attention`}>{attention}</span>}</a>)}
        <div class="nav-note">One top-level request runs at a time; items inside it run in bounded waves.</div>
      </nav>
      <main class="main">{children}</main>
    </div>
  </div>;
}
