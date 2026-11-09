import { useEffect, useRef, useState } from 'preact/hooks';
import { api, resources, SignedOutError } from '../api';
import { onSignedOut, usePoll, useConnection } from '../state';
import { Card, Chip } from './ui';
import { CopyCommand } from '../pages/RegisterProject';
type Job = { attemptId: string; method: string; state: string; message: string; challenge?: { url: string; code: string } };
type Setup = { available: boolean; connection: { saved: boolean; method?: string }; locked?: boolean; unavailable?: boolean; busy: boolean; job?: Job };
export function SetupConnection({ locked, installed, engine = 'codex' }: { locked: boolean; installed: boolean; engine?: 'codex' | 'claude' }) {
  const claude = engine === 'claude'; const endpoint = claude ? '/setup/claude-auth' : '/setup/auth';
  const setup = usePoll(`setup-auth-${engine}`, () => api<Setup>(endpoint), 2000);
  const status = usePoll(resources.status.key, resources.status.load, resources.status.intervalMs);
  const online = useConnection().online; const guard = useRef(false);
  const [keyForm, setKeyForm] = useState(false); const [method, setMethod] = useState<'api-key' | 'subscription'>('api-key'); const [key, setKey] = useState('');
  const [pending, setPending] = useState(false); const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const state = setup.data; const job = state?.job;
  useEffect(() => { if (job && job.state !== 'running') status.reload(); }, [job?.attemptId, job?.state]);
  const disabled = pending || !online || !state?.available || state.busy || locked || state.locked || !installed;
  const run = async (method: 'chatgpt' | 'api-key' | 'subscription' | 'cancel') => {
    if (guard.current) return; guard.current = true; setPending(true); setError('');
    const value = key; setKey(''); setKeyForm(false);
    try {
      await api(method === 'cancel' ? `${endpoint}/cancel` : endpoint, { method: 'POST', body: method === 'cancel' ? {} : { attemptId: crypto.randomUUID(), method, ...(method !== 'chatgpt' ? { apiKey: value } : {}) } });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Setup request failed.'); setUncertain(true);
      if (e instanceof SignedOutError) onSignedOut();
    } finally { guard.current = false; setPending(false); setup.reload(); }
  };
  return <Card title={claude ? 'Connect Claude' : '1 · Connect Codex'} right={<Chip tone={locked || state?.locked ? 'warn' : state?.connection.saved ? 'ok' : 'neutral'}>{locked || state?.locked ? 'Credentials locked' : state?.connection.saved ? 'Connection saved' : 'Not connected'}</Chip>}><div class="form-stack">
    <b>{claude ? 'Claude · Anthropic' : 'Codex · OpenAI'}</b><span>{claude ? 'Use an Anthropic API key or connect your personal subscription token. Saved credentials do not verify model access or quota.' : 'Use your ChatGPT account or an OpenAI API key. Sign-in and model access are separate; no paid test runs here.'}</span>
    {(locked || state?.locked) && <div class="note warn">Run <code>./devagents start</code> to unlock the encrypted vault using your OS credential store.</div>}
    {(!installed || state?.unavailable) && <div class="note warn">{!installed && <b>✕ Not installed · </b>}Check the coding runtime and OS credential store. Start or rebuild with <code>./devagents start --build</code>.</div>}
    {!state?.available && <div class="note info">Browser sign-in is unavailable on this service. Use terminal setup below.</div>}
    {state?.connection.saved && <span>Saved method: {state.connection.method}. Future starts reuse this connection. Starting another sign-in replaces it.</span>}
    {(error || setup.error) && <div class="note bad" role="alert">{error || setup.error}</div>}
    {uncertain && <div class="note warn">The request may have reached the service. Check the current sign-in state before starting another attempt. <button class="btn" disabled={pending || state?.busy || !online} onClick={() => { setup.reload(); setUncertain(false); }}>Check state and continue</button></div>}
    {job && <div class={`note ${job.state === 'failed' ? 'bad' : 'info'}`} role="status"><b>{job.state}</b><p>{job.message}</p>{job.challenge && job.challenge.url === 'https://auth.openai.com/codex/device' && <><a class="btn primary" href={job.challenge.url} target="_blank" rel="noopener noreferrer">Open ChatGPT sign-in</a><CopyCommand command={job.challenge.code} /><p>This one-time code belongs to your current sign-in. Never share it.</p></>}</div>}
    {state?.busy ? job ? <button class="btn" disabled={pending || !online} onClick={() => void run('cancel')}>Cancel sign-in</button> : <span>Another browser or terminal is signing in. Wait for it to finish.</span> : <div class="actions">{claude ? <button class="btn primary" disabled={disabled || uncertain} onClick={() => { setMethod('subscription'); setKeyForm(true); }}>Use my Claude subscription</button> : <button class="btn primary" disabled={disabled || uncertain} onClick={() => void run('chatgpt')}>Sign in with ChatGPT</button>}<button class="btn" disabled={disabled || uncertain} onClick={() => { setMethod('api-key'); setKeyForm(true); }}>Use an {claude ? 'Anthropic' : 'OpenAI'} API key</button></div>}
    {keyForm && <form class="form-stack" onSubmit={e => { e.preventDefault(); void run(method); }}><label class="field">{method === 'subscription' ? 'Claude subscription token' : claude ? 'Anthropic API key' : 'OpenAI API key'}<input type="password" autoComplete="off" spellcheck={false} maxLength={4096} value={key} onInput={e => setKey(e.currentTarget.value)} /></label>{method === 'subscription' && <><p>Run the official Claude CLI command below on your computer, sign in with your subscription and paste the generated token here. Keep it private.</p><CopyCommand command="claude setup-token" /></>}<span>Sent to this local service and saved using its secure credential store. Not saved in browser storage. {method === 'subscription' ? 'Subscription limits apply; no per-run invoice cost is available.' : 'API usage has separate billing.'}</span><div class="actions"><button class="btn primary" disabled={disabled || !key.trim()}>Save connection</button><button class="btn" type="button" onClick={() => { setKey(''); setKeyForm(false); }}>Cancel</button></div></form>}
    {!claude && <span>Device sign-in may need enabling in <a href="https://chatgpt.com/#settings/Security" target="_blank" rel="noopener noreferrer">ChatGPT Security settings</a>.</span>}
    <div class="actions"><button class="btn" disabled title="Local model execution is not available yet">Local / other models · coming later</button></div>
    {claude && <p class="hint">Personal local connection. Anthropic requires approval for third-party products offering subscription login; a subscription alone is not that approval.</p>}
    <details><summary>Continue in your terminal</summary><CopyCommand command={claude ? "docker compose exec devagents node dist/cli/main.js auth claude --method api-key" : "./devagents setup --terminal"} /><CopyCommand command={claude ? "docker compose exec devagents node dist/cli/main.js auth claude --method subscription" : "npm run cli -- auth setup"} /></details>
  </div></Card>;
}
