export type TokenUsage = { input: number; cachedInput: number | null; output: number; total: number };
export type Price = { inputPerMillion: number; cachedInputPerMillion: number; outputPerMillion: number; asOf: string };
export type UsageEvent = { sequence: number; kind: string; at: string; data: unknown };
export type UsageRun = {
  runId: string; phase: string; workItemId: string | null; agentId: string | null; model: string | null;
  attempt: number; startedAt: string; status: string; tokens: TokenUsage | null;
  billing: 'api' | 'subscription' | 'unknown'; estimatedUsd: number | null; price: Price | null;
  priceBasis: 'recorded' | 'reference'; unavailableReason: string | null;
};
export type UsageTotals = {
  input: number; cachedInput: number; output: number; total: number;
  reportedRuns: number; missingRuns: number; missingCacheRuns: number; pricedRuns: number; unpricedRuns: number;
  apiEstimatedUsd: number; equivalentEstimatedUsd: number; apiPricedRuns: number; equivalentPricedRuns: number;
};
export type TaskUsage = { runs: UsageRun[]; totals: UsageTotals; pricingSource: string; eur: { usdToEur: number; asOf: string } | null };
