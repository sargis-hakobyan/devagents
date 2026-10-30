import { resources } from '../api';
import { Card, Chip, Empty, ItemChip, Later, Skeleton, StateChip, ErrorNote } from '../components/ui';
import { finishedStates, relative, taskState, truncate } from '../format';
import { useNow, usePoll } from '../state';

export function OverviewPage() {
  const now = useNow();
  const { data: overview, error } = usePoll(resources.overview.key, resources.overview.load, resources.overview.intervalMs);
  const status = usePoll(resources.status.key, resources.status.load, resources.status.intervalMs).data;
  if (!overview && error) return <ErrorNote message={error} />;
  if (!overview) return <><Skeleton rows={2} label="Loading overview" /><Skeleton rows={4} /></>;
  const counts = overview.counts; const n = (...states: string[]) => states.reduce((sum, s) => sum + (counts[s] ?? 0), 0);
  const running = overview.active.filter(t => t.state !== 'planning' && t.state !== 'ready'); const queued = overview.active.filter(t => t.state === 'ready' || t.state === 'planning');
  const headline = overview.attention.length ? `${overview.attention.length} task${overview.attention.length > 1 ? 's' : ''} waiting for you` : running.length ? 'Work is running' : queued.length ? 'Work is queued' : 'Nothing is running';
  return <>
    <div class="page-head">
      <div><div class="h">Overview</div><h1>Workspace</h1><p>{headline}{running[0] ? ` · ${running[0].workItems.filter(i => i.state === 'completed').length} of ${running[0].workItems.length || '?'} items integrated on the running task` : ''}.</p></div>
      <Later label="Submit work" increment="U3" reason="Task submission arrives in U3. Use the CLI: devagents tasks submit" primary />
    </div>
    <div class="cols">
      <div class="stack">
        {overview.attention.length > 0 && <Card tone="warn">
          <div class="strip warn"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#B45309" stroke-width="2.5" aria-hidden="true"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>Needs your attention · {overview.attention.length}</div>
          {overview.attention.map(t => <div key={t.id} style={{ padding: '12px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap', borderTop: '1px solid var(--row)' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
              <div><b>{taskState(t).label}</b> · <span class="mono">{t.projectId}</span>{t.state === 'awaiting_plan_approval' && <> · v{t.version}</>}</div>
              <div class="muted wrap-anywhere" style={{ fontSize: '13px' }}>{truncate(t.request, 140)} · {t.items ? `${t.items} item${t.items > 1 ? 's' : ''} · ` : ''}waiting {relative(t.updatedAt, now)} · nothing runs until you decide</div>
            </div>
            <a class="btn primary" href={`/ui/tasks/${t.id}`}>{t.state === 'awaiting_plan_approval' ? 'Review plan' : 'Open task'}</a>
          </div>)}
        </Card>}
        {running.length === 0 && queued.length === 0 ? <Card title="Currently running"><Empty title="Nothing is running">{status?.codex.signedIn ? 'Submit work with the CLI to start a task.' : 'Sign in to Codex and register a project to start.'}</Empty></Card> : running.concat(queued).slice(0, 2).map(t => <Card key={t.id} title={<span style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}><StateChip task={t} />{truncate(t.request, 80)}<span class="muted mono">{t.projectId} · legacy agent configuration</span></span>} right={<a href={`/ui/tasks/${t.id}`} style={{ fontWeight: 700 }}>Open task →</a>}
          foot={t.workItems.length ? `Measured: ${t.workItems.filter(i => i.state === 'completed').length} of ${t.workItems.length} items integrated · updated ${relative(t.updatedAt, now)}. Combined validation, independent review and one local commit follow.` : `No work items yet · updated ${relative(t.updatedAt, now)}`}>
          {t.workItems.length > 0 ? <div class="scroll-x"><table>
            <thead><tr><th>Item</th><th>Agent</th><th>Depends</th><th>Stage</th><th>Repairs</th><th>Updated</th></tr></thead>
            <tbody>{t.workItems.map(i => <tr key={i.itemId} class={['running', 'validating', 'reviewing', 'repairing', 'creating', 'checkpointing', 'integrating'].includes(i.state) ? 'current' : ''}>
              <td class="mono"><b>{i.itemId}</b></td><td>{i.agentId ?? '—'}</td><td class="mono">{i.dependsOn?.length ? i.dependsOn.join(', ') : '—'}</td><td><ItemChip state={i.state} /></td><td class="mono">{i.repairCycles ?? 0}</td><td class="muted">{i.updatedAt ? relative(i.updatedAt, now) : '—'}</td>
            </tr>)}</tbody></table></div> : <div class="muted" style={{ padding: '12px 14px' }}>{t.state === 'planning' ? 'The Tech Lead is planning; items appear when the plan is stored.' : 'Queued behind the current request.'}</div>}
        </Card>)}
        <Card title="Recent outcomes" right={<a href="/ui/tasks" style={{ fontWeight: 700 }}>All tasks</a>}>
          {overview.recent.length === 0 ? <Empty title="No finished tasks yet" /> : <div class="scroll-x"><table>
            <thead><tr><th>Finished</th><th>Task</th><th>Project</th><th>Outcome</th><th>Result</th></tr></thead>
            <tbody>{overview.recent.map(t => <tr key={t.id} class="row">
              <td class="muted mono">{relative(t.updatedAt, now)}</td><td><a href={`/ui/tasks/${t.id}`} style={{ fontWeight: 600, color: 'var(--text)', textDecoration: 'none' }}>{truncate(t.request, 80)}</a></td><td class="mono">{t.projectId}</td><td><StateChip task={t} /></td>
              <td class={t.commit ? 'mono' : 'muted'}>{t.commit ? `${t.commit.slice(0, 7)} · ${t.branch ?? ''}` : t.error ? truncate(t.error, 90) : 'No commit'}</td>
            </tr>)}</tbody></table></div>}
        </Card>
      </div>
      <aside class="rail">
        <Card title="Right now"><div style={{ padding: '12px 16px' }}>
          <dl class="counts">
            <dt>Running</dt><dd>{n('running', 'validating', 'reviewing', 'committing', 'repairing')}</dd>
            <dt>Planning · queued</dt><dd>{n('planning', 'ready')}</dd>
            <dt>Awaiting approval</dt><dd style={{ color: n('awaiting_plan_approval') ? 'var(--warn-text)' : undefined }}>{n('awaiting_plan_approval')}</dd>
            <dt>Awaiting mode</dt><dd style={{ color: n('awaiting_mode') ? 'var(--warn-text)' : undefined }}>{n('awaiting_mode')}</dd>
            <dt>Finished</dt><dd>{n(...finishedStates)}</dd>
          </dl>
          <div class="muted" style={{ fontSize: '12px', marginTop: '10px' }}>Saved teams arrive in U2; agents today come from YAML templates.</div>
        </div></Card>
        <Card title="Connection"><div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {status ? <>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>{status.codex.vaultLocked ? <Chip tone="warn">⚠ Credentials locked</Chip> : status.codex.signedIn ? <Chip tone="ok">✓ Sign-in saved</Chip> : status.codex.installed ? <Chip tone="warn">⚠ Not signed in</Chip> : <Chip tone="bad">✕ Codex not installed</Chip>}<span class="muted" style={{ fontSize: '13px' }}>{status.codex.version ?? 'Codex'} · {status.codex.credentialStore === 'file' ? 'encrypted vault' : 'OS keychain'}</span></div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}><Chip tone="warn">⚠ Not verified</Chip><span class="muted" style={{ fontSize: '13px' }}>model access this start</span></div>
            <div class="muted" style={{ fontSize: '12px' }}>A saved sign-in does not establish quota. The optional test uses your allowance and never runs automatically.</div>
          </> : <div class="sk" style={{ width: '70%' }} />}
          <a href="/ui/settings" style={{ fontSize: '13px', fontWeight: 700 }}>Settings →</a>
        </div></Card>
        <Card title="Scheduler"><div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <div class="mono">{status ? `concurrency ${status.limits.concurrency} · repairs ${status.limits.maxRepairCycles} · wave scheduling` : '…'}</div>
          <div class="muted" style={{ fontSize: '12px' }}>The next request starts after the current one finishes.</div>
        </div></Card>
      </aside>
    </div>
  </>;
}
