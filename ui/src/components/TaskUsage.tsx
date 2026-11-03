import { useEffect, useState } from 'preact/hooks';
import { api } from '../api';
import { forget, usePoll } from '../state';
import { Card, ErrorNote, Skeleton } from './ui';
import type { TaskUsage as Usage, UsageRun } from '../../../src/domain/usage-types';

const number = (n: number | null) => n === null ? 'Unavailable' : n.toLocaleString();
const phases: Record<string, string> = { planning: 'Planning', setup: 'Setup', implementation: 'Development', qa: 'QA', review: 'Review' };
export function TaskUsage({ id }: { id: string }) {
  const poll = usePoll(`usage:${id}`, () => api<Usage>(`/tasks/${id}/usage`), 5000);
  useEffect(() => () => forget(`usage:${id}`), [id]);
  const [currency, setCurrency] = useState('USD');
  const [manualRate, setManualRate] = useState(''); const [rateDate, setRateDate] = useState('');
  if (!poll.data && poll.error) return <Card title="Usage unavailable"><ErrorNote message={poll.error} /><button class="btn" onClick={poll.reload}>Retry usage</button></Card>;
  if (!poll.data) return <Skeleton label="Reading reported usage…" />;
  const { runs, totals, eur, pricingSource } = poll.data;
  const conversion = manualRate ? { usdToEur: Number(manualRate), asOf: rateDate } : eur;
  const validRate = conversion && Number.isFinite(conversion.usdToEur) && conversion.usdToEur > 0 && conversion.usdToEur <= 1000 && /^\d{4}-\d{2}-\d{2}$/.test(conversion.asOf);
  const money = (usd: number | null) => usd === null ? 'Unavailable' : currency === 'EUR' && !validRate ? 'Set exchange rate' : new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(usd * (currency === 'EUR' ? conversion!.usdToEur : 1));
  const stepCost = (attempts: UsageRun[]) => {
    const apiRuns = attempts.filter(r => r.estimatedUsd !== null && r.billing === 'api');
    const equivalentRuns = attempts.filter(r => r.estimatedUsd !== null && r.billing !== 'api');
    return [apiRuns.length ? `${money(apiRuns.reduce((sum, r) => sum + r.estimatedUsd!, 0))} API estimate` : '', equivalentRuns.length ? `${money(equivalentRuns.reduce((sum, r) => sum + r.estimatedUsd!, 0))} API-equivalent` : ''].filter(Boolean).join(' · ');
  };
  const groups = new Map<string, UsageRun[]>();
  for (const run of runs) { const key = `${run.workItemId ?? '@task'}:${run.phase}`; groups.set(key, [...groups.get(key) ?? [], run]); }
  return <Card title="Reported tokens & estimated cost" right={<label>Currency <select aria-label="Usage currency" value={currency} onChange={e => setCurrency(e.currentTarget.value)}><option>USD</option><option>EUR</option></select></label>}>
    <div class="form-stack">
      {poll.error && <ErrorNote message={`Showing last fetched usage. ${poll.error}`} />}
      <p class="muted usage-note">Tokens are reported by the model provider. Costs are DevAgents estimates, never billing records. Subscription runs show an API-equivalent estimate, not money charged to your account.</p>
      {currency === 'EUR' && <div class="note info form-stack usage-conversion">
        <span>EUR is a conversion estimate. {eur && !manualRate ? `Configured rate: ${eur.usdToEur} EUR per USD, dated ${eur.asOf}.` : 'Enter a reference exchange rate and its date; no live rate is fetched.'}</span>
        <div class="actions"><label class="field">EUR per USD<input type="number" min="0.000001" max="1000" step="any" placeholder={eur ? String(eur.usdToEur) : 'Enter rate'} value={manualRate} onInput={e => setManualRate(e.currentTarget.value)} /></label><label class="field">Rate date<input type="date" value={rateDate} onInput={e => setRateDate(e.currentTarget.value)} /></label></div>
        {validRate && <span>Conversion: 1 USD = {conversion!.usdToEur} EUR · {conversion!.asOf}</span>}
      </div>}
      <div class="usage-totals">
        <div><span class="muted">Reported tokens</span><strong>{totals.reportedRuns ? number(totals.total) : 'Unavailable'}</strong><small>{totals.reportedRuns} of {runs.length} runs reported · {totals.missingRuns} missing</small></div>
        <div><span class="muted">Estimated API cost</span><strong>{money(totals.apiPricedRuns ? totals.apiEstimatedUsd : null)}</strong><small>{totals.apiPricedRuns} priced API runs</small></div>
        <div><span class="muted">API-equivalent estimate</span><strong>{money(totals.equivalentPricedRuns ? totals.equivalentEstimatedUsd : null)}</strong><small>{totals.equivalentPricedRuns} priced subscription / unknown billing runs · not a charge</small></div>
      </div>
      <div class="muted">{number(totals.input)} input · {number(totals.cachedInput)} reported cached input (included in input) · {number(totals.output)} output. {totals.missingCacheRuns > 0 && `${totals.missingCacheRuns} runs lack cache counts. `}{totals.unpricedRuns} runs have no cost estimate; totals cover reported and priced runs only.</div>
      {runs.length === 0 ? <div class="note info">No agent runs recorded yet. Local validation commands do not use model tokens themselves.</div> : [...groups.entries()].map(([key, attempts]) => <details key={key} class="usage-step">
        <summary><b>{phases[attempts[0]!.phase] ?? attempts[0]!.phase}</b> · {attempts[0]!.workItemId ? `item ${attempts[0]!.workItemId}` : 'task'} · {attempts.length} {attempts.length === 1 ? 'attempt' : 'attempts'} · {attempts.some(r => r.tokens) ? `${number(attempts.reduce((n, r) => n + (r.tokens?.total ?? 0), 0))} reported tokens` : 'usage unavailable'}{stepCost(attempts) && <span class="usage-step-cost">{stepCost(attempts)} · {attempts.filter(r => r.estimatedUsd === null).length} unpriced attempts</span>}</summary>
        <div class="usage-table-scroll" role="region" aria-label={`${phases[attempts[0]!.phase] ?? attempts[0]!.phase} usage attempts`} tabIndex={0}><table class="usage-table"><thead><tr><th>Attempt / agent</th><th>Model</th><th>Input</th><th>Cached input</th><th>Output</th><th>Estimated cost</th></tr></thead><tbody>{attempts.map(run => <tr key={run.runId}>
          <td><b>Attempt {run.attempt}</b><small>{run.status} · {run.agentId ?? 'Unknown agent'}</small></td><td>{run.model ?? 'Runtime default (unknown)'}</td>
          <td>{number(run.tokens?.input ?? null)}</td><td>{number(run.tokens?.cachedInput ?? null)}</td><td>{number(run.tokens?.output ?? null)}</td>
          <td>{money(run.estimatedUsd)}<small>{run.unavailableReason ?? (run.billing === 'api' ? 'API estimate' : run.billing === 'subscription' ? 'Subscription · API-equivalent, not a charge' : 'Unknown billing · API-equivalent')}</small>{run.price && <small>{run.priceBasis === 'recorded' ? 'Recorded' : 'Reference'} rates · {run.price.asOf}</small>}</td>
        </tr>)}</tbody></table></div>
      </details>)}
      <details><summary>How these estimates work</summary><p>Input plus output gives total tokens. Cached input is a subset of input and is not added again. Each attempt is counted once, including reported usage from failed attempts. Running or interrupted calls can have missing usage.</p><p>Cost = (uncached input × input rate + cached input × cached rate + output × output rate) / 1,000,000. Rates use USD per million tokens. <a href={pricingSource} target="_blank" rel="noreferrer">Published reference rates</a> use standard speed and short context; configured overrides may differ. Cache-write premiums, long-context or speed premiums, tool fees, taxes and discounts are not included.</p><p>Pin a model in the team to enable estimates for future runs. A runtime-selected model whose identity was not recorded cannot be priced. New runs retain their pricing snapshot; historical runs use a reference estimate only when their saved model and provider are known.</p></details>
    </div>
  </Card>;
}
