import type { ExecutionEvent } from '../domain/execution.js';
import type { WorkspacePersistence } from './prisma.js';

const runs = ['run-started', 'run-completed', 'run-failed'];
const common = ['runId', 'phase', 'agentId', 'workItemId'];
const projections = {
  execution: {
    kinds: [...runs, 'validation-started', 'validation-failed', 'validation', 'qa-result', 'commit-created'],
    fields: [...common, 'engine', 'output.summary', 'output.approved', 'output.findings', 'error', 'feedback',
      'state', 'executable', 'args', 'exitCode', 'truncated', 'validationId', 'timeoutMs', 'timedOut', 'commit'],
  },
  usage: {
    kinds: [...runs, 'progress'],
    fields: [...common, 'model', 'auth', 'providerKind', 'kind', 'usage', 'data', 'usagePrice'],
  },
};
const limits: Record<string, number> = { engine: 256, summary: 4000, error: 4000, feedback: 4000 };

/** Project in the database so large command logs and engine output stay out of ordinary reads.
 * JSON can encode NULs and isolated surrogates that PostgreSQL text cannot represent. When
 * a row has Unicode escapes, apply the same field selection to its original JSON in Node. */
export async function projectEvidence(db: WorkspacePersistence, id: string, view: keyof typeof projections): Promise<ExecutionEvent[]> {
  const { fields, kinds } = projections[view];
  const pairs = fields.map(field => {
    const key = field.split('.').at(-1)!;
    const path = "'{data," + field.replace('.', ',') + "}'";
    const value = limits[key] ? 'substr(doc #>> ' + path + ', 1, ' + limits[key] + ')' : 'doc #> ' + path;
    return "'" + key + "', " + value;
  });
  const rows = await db.prepare(`WITH input AS MATERIALIZED (
      SELECT sequence, kind, data, CASE WHEN strpos(data, $3)=0 THEN data::json END AS doc
      FROM evidence WHERE task_id=$1 AND kind=ANY($2::text[])
    ) SELECT sequence, kind, doc->>'at' AS at, json_build_object(${pairs.join(', ')}) AS facts,
      doc #> '{data,usagePrice}' IS NOT NULL AS has_price, CASE WHEN doc IS NULL THEN data END AS raw
    FROM input WHERE kind<>'progress' OR doc IS NULL OR doc #>> '{data,kind}' IN ('started','usage')
    ORDER BY sequence`).all(id, kinds, '\\u');
  const events: ExecutionEvent[] = [];
  for (const row of rows) {
    let facts = row.facts as Record<string, unknown>;
    let at = row.at;
    if (typeof row.raw === 'string') {
      const original = JSON.parse(row.raw);
      at = original.at;
      const data = original.data ?? {};
      if (row.kind === 'progress' && !['started','usage'].includes(data.kind)) continue;
      facts = {};
      for (const field of fields) {
        const parts = field.split('.');
        const key = parts.at(-1)!;
        const value = parts.length === 1 ? data[key] : data[parts[0]!]?.[key];
        if (key === 'usagePrice' && value === undefined) continue;
        facts[key] = typeof value === 'string' && limits[key] ? Array.from(value).slice(0, limits[key]).join('') : value ?? null;
      }
    } else if (!row.has_price) delete facts.usagePrice;
    events.push({ sequence: Number(row.sequence), kind: String(row.kind), at: String(at), data: facts });
  }
  return events;
}
