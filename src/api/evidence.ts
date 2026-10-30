/** Bounded structured facts survive even when the display payload becomes a text preview. */
export function evidenceMetadata(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== 'object') return {};
  const source = data as Record<string, unknown>; const metadata: Record<string, unknown> = {};
  for (const key of ['workItemId', 'itemId', 'agentId', 'runId', 'phase', 'state', 'kind', 'commit', 'executable']) {
    if (typeof source[key] === 'string') metadata[key] = source[key].slice(0, 256);
  }
  if (typeof source.exitCode === 'number' && Number.isFinite(source.exitCode)) metadata.exitCode = source.exitCode;
  if (typeof source.truncated === 'boolean') metadata.truncated = source.truncated;
  if (Array.isArray(source.args)) metadata.args = source.args.slice(0, 16).filter((v): v is string => typeof v === 'string').map(v => v.slice(0, 128));
  const output = source.output;
  if (output && typeof output === 'object') {
    const review = output as Record<string, unknown>; const facts: Record<string, unknown> = {};
    if (typeof review.approved === 'boolean') facts.approved = review.approved;
    if (Array.isArray(review.findings)) facts.findingsCount = review.findings.length;
    if (typeof review.summary === 'string') facts.summary = review.summary.slice(0, 512);
    metadata.output = facts;
  }
  return metadata;
}
