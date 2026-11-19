import { useState } from 'preact/hooks';
import { api, login } from '../api';
import { usePoll } from '../state';
import { Card, ErrorNote, Skeleton } from '../components/ui';
import { Spark } from '../components/Shell';
import { SignedOutPage } from './Simple';

export function LoginPage() {
  const config = usePoll('login-method', () => api<{ method: 'local' | 'password' }>('/ui/auth'), 60000);
  const [username, setUsername] = useState(''); const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string>();
  if (config.data?.method === 'local') return <SignedOutPage />;
  const submit = async (event: Event) => {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError(undefined);
    try {
      await login(username, password);
      setPassword('');
      // Start a fresh application instance: no data cached before sign-out survives a new login.
      location.replace(new URLSearchParams(location.search).get('next') === 'claude' ? '/ui/settings/claude' : '/ui/');
    } catch (e) { setPassword(''); setError(e instanceof Error ? e.message : 'Sign-in failed'); setBusy(false); }
  };
  return <div class="login-page">
    <header class="band"><a href="/ui/" class="brand-name"><Spark />devagents</a></header>
    <main class="login-main">
      {config.error && <><ErrorNote message={config.error} /><button type="button" class="btn" onClick={config.reload}>Retry</button></>}
      {!config.data && !config.error && <Skeleton rows={2} label="Loading sign-in" />}
      {config.data?.method === 'password' && <Card>
        <form class="form-stack" onSubmit={submit} aria-busy={busy}>
          <div><h1>Sign in</h1><p class="muted">Enter your DevAgents username and password.</p></div>
          {error && <div class="note bad" role="alert">{error}</div>}
          <label class="field" for="login-username">Username<input id="login-username" name="username" autoComplete="username" required maxLength={100} value={username} disabled={busy} onInput={e => setUsername(e.currentTarget.value)} /></label>
          <label class="field" for="login-password">Password<input id="login-password" name="password" type="password" autoComplete="current-password" required maxLength={1024} value={password} disabled={busy} onInput={e => setPassword(e.currentTarget.value)} /></label>
          <button class="btn primary" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
      </Card>}
    </main>
  </div>;
}
