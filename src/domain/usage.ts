import type { Price, TokenUsage, UsageEvent, UsageRun, TaskUsage } from './usage-types.js';
import type { AppConfig, Task } from './schemas.js';

// Standard, short-context reference rates. These are estimates, never billing records.
export const pricingSource = 'https://developers.openai.com/api/docs/pricing';
export const referencePrices: Readonly<Record<string, Price>> = Object.fromEntries([
  ['gpt-5.3-codex', 1.75, 0.175, 14], ['gpt-6-astra', 5, 0.5, 25],
  ['gpt-6.1-sol', 1, 0.05, 5], ['gpt-6.1-terra', 0.5, 0.025, 2.5], ['gpt-6-luna', 0.05, 0.005, 0.25],
].map(([model, input, cached, output]) => [model, { inputPerMillion: input, cachedInputPerMillion: cached, outputPerMillion: output, asOf: '2026-11-03' }])) as Record<string, Price>;
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const string = (v: unknown): string | null => typeof v === 'string' ? v.slice(0, 200) : null;
export function normalizeUsage(value: unknown): TokenUsage | null {
  const u = object(value);
  if (!count(u.input_tokens) || !count(u.output_tokens) || !Number.isSafeInteger(u.input_tokens + u.output_tokens)) return null;
  const cached = u.cached_input_tokens ?? object(u.input_tokens_details).cached_tokens;
  if (cached !== undefined && (!count(cached) || cached > u.input_tokens)) return null;
  return { input: u.input_tokens, cachedInput: cached === undefined ? null : cached as number, output: u.output_tokens, total: u.input_tokens + u.output_tokens };
}
export function priceFor(model: string, config: AppConfig): Price | null {
  const custom = config.usagePricing?.models;
  return custom && Object.hasOwn(custom, model) ? custom[model]! : Object.hasOwn(referencePrices, model) ? referencePrices[model]! : null;
}
export function taskUsage(task: Task, events: UsageEvent[], config: AppConfig): TaskUsage {
  const runs = new Map<string, UsageRun>();
  const attempts = new Map<string, number>();
  for (const e of events) {
    const d = object(e.data); const runId = string(d.runId); if (!runId) continue;
    let run = runs.get(runId);
    if (!run) {
      const agentId = string(d.agentId);
      const agent = task.agents?.find(a => a.id === agentId) ?? task.team?.members.find(a => a.id === agentId);
      const model = string(d.model) ?? (agent?.model !== 'default' ? agent?.model ?? null : null);
      const provider = task.team?.providers.find(p => p.id === agent?.provider);
      const auth = string(d.auth) ?? provider?.auth;
      const phase = string(d.phase) ?? 'unknown'; const workItemId = string(d.workItemId);
      const key = `${workItemId ?? '@task'}:${phase}`; const attempt = (attempts.get(key) ?? 0) + 1; attempts.set(key, attempt);
      const recorded = Object.hasOwn(d, 'usagePrice');
      // A missing historical provider is unknown, never inferred from today's configuration.
      const openai = d.providerKind === 'openai' || (!d.providerKind && provider?.kind === 'openai');
      const price = recorded ? readPrice(d.usagePrice) : openai && model ? priceFor(model, config) : null;
      run = { runId, phase, workItemId, agentId, model: model === 'default' ? null : model, attempt, startedAt: e.at,
        status: 'running', tokens: null, billing: auth === 'api-key' ? 'api' : 'unknown',
        estimatedUsd: null, price, priceBasis: recorded ? 'recorded' : 'reference', unavailableReason: null };
      runs.set(runId, run);
    }
    const billing = object(d.data).billing;
    if (e.kind === 'progress' && d.kind === 'started' && ['api', 'subscription', 'unknown'].includes(String(billing))) run.billing = billing as UsageRun['billing'];
    // Completion repeats the usage progress event. Replace it, never sum both copies.
    if (e.kind === 'progress' && d.kind === 'usage') run.tokens = normalizeUsage(d.data);
    if (e.kind === 'run-completed') { run.status = 'completed'; run.tokens = normalizeUsage(d.usage) ?? run.tokens; }
    if (e.kind === 'run-failed') run.status = 'failed';
  }
  const rows = [...runs.values()];
  const totals = { input: 0, cachedInput: 0, output: 0, total: 0, reportedRuns: 0, missingRuns: 0, missingCacheRuns: 0, pricedRuns: 0, unpricedRuns: 0, apiEstimatedUsd: 0, equivalentEstimatedUsd: 0, apiPricedRuns: 0, equivalentPricedRuns: 0 };
  for (const run of rows) {
    if (run.status === 'running' && ['completed', 'failed', 'cancelled'].includes(task.state)) run.status = 'interrupted';
    const u = run.tokens;
    run.unavailableReason = !u ? 'Usage not reported' : !run.model ? 'Runtime model was not recorded' : !run.price ? 'No price recorded for this model/provider' : u.cachedInput === null ? 'Cached input usage not reported' : null;
    if (u && run.price && run.unavailableReason === null) {
      run.estimatedUsd = ((u.input - u.cachedInput!) * run.price.inputPerMillion + u.cachedInput! * run.price.cachedInputPerMillion + u.output * run.price.outputPerMillion) / 1_000_000;
      totals.pricedRuns++;
      if (run.billing === 'api') { totals.apiEstimatedUsd += run.estimatedUsd; totals.apiPricedRuns++; }
      else { totals.equivalentEstimatedUsd += run.estimatedUsd; totals.equivalentPricedRuns++; }
    } else totals.unpricedRuns++;
    if (u) { totals.reportedRuns++; totals.input += u.input; totals.cachedInput += u.cachedInput ?? 0; totals.output += u.output; totals.total += u.total; if (u.cachedInput === null) totals.missingCacheRuns++; }
    else totals.missingRuns++;
  }
  return { runs: rows, totals, pricingSource, eur: config.usagePricing?.eur ?? null };
}
function readPrice(value: unknown): Price | null {
  const p = object(value);
  if (![p.inputPerMillion, p.cachedInputPerMillion, p.outputPerMillion].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1_000_000) || typeof p.asOf !== 'string') return null;
  return p as Price;
}
