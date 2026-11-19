import type { Pool } from 'pg';
import type { TaskEvent } from '../domain/schemas.js';
import { AppError } from '../domain/errors.js';
import type { Store } from './store.js';

type Stream = 'events' | 'evidence';
type Entry = Awaited<ReturnType<Store['evidenceEntry']>>;
const streams = ['events', 'evidence'] as const;

/** The workspace appends redacted records in the transaction that authorizes the change. Replicate
 * from that durable journal in sequence order. Only advance the cursor after a committed batch. */
export class PostgresHistory {
  private cursor?: Record<Stream, number>;
  private copying?: Promise<void>;
  constructor(private readonly pool: Pool, private readonly owner: string, private readonly source: Store) {}

  async initialize() {
    if (this.cursor) return this.cursor;
    const cursor = { events: 0, evidence: 0 };
    for (const stream of streams) {
      const tip = await this.pool.query(`SELECT sequence,task_id,kind,payload::text FROM public.task_history
        WHERE owner_id=$1 AND stream=$2 ORDER BY sequence DESC LIMIT 1`, [this.owner, stream]);
      if (!tip.rowCount) continue;
      const row = tip.rows[0];
      const seq = Number(row.sequence);
      const [local] = await this.source.historyBatch(stream, seq - 1, seq);
      if (local?.taskId !== row.task_id || local?.kind !== row.kind || local?.data !== row.payload) {
        throw new AppError('history_diverged', 'Archived and workspace task history differ. Restore a consistent workspace before continuing.', 409);
      }
      cursor[stream] = seq;
    }
    this.cursor = cursor;
    return cursor;
  }

  private async copy(ends: Record<Stream, number>) {
    const cursor = await this.initialize();
    for (const stream of streams) {
      while (cursor[stream] < ends[stream]) {
        const batch = await this.source.historyBatch(stream, cursor[stream], ends[stream]);
        if (!batch.length) throw new AppError('history_diverged', 'A local history batch is missing', 409);
        const params = [this.owner, stream, batch.map(r => r.sequence), batch.map(r => r.taskId), batch.map(r => r.kind), batch.map(r => r.data)];
        const input = 'unnest($3::bigint[], $4::uuid[], $5::text[], $6::text[]) AS b(seq,id,kind,body)';
        const written = await this.pool.query(`INSERT INTO public.task_history(owner_id,stream,sequence,task_id,kind,payload)
          SELECT $1,$2,seq,id,kind,body::json FROM ${input} ON CONFLICT DO NOTHING`, params);
        if (written.rowCount !== batch.length) {
          // A previous commit may have succeeded before its acknowledgment was lost.
          const equal = await this.pool.query(`SELECT count(*) AS n FROM ${input} JOIN public.task_history h
            ON h.owner_id=$1 AND h.stream=$2 AND h.sequence=b.seq AND h.task_id=b.id
            AND h.kind IS NOT DISTINCT FROM b.kind AND h.payload::text=b.body`, params);
          if (Number(equal.rows[0].n) !== batch.length) throw new AppError('history_diverged', 'Conflicting PostgreSQL history entry', 409);
        }
        cursor[stream] = batch[batch.length - 1]!.sequence;
      }
    }
  }

  async flush() {
    const ends = { events: await this.source.historyEnd('events'), evidence: await this.source.historyEnd('evidence') };
    try {
      while (!this.cursor || streams.some(s => this.cursor![s] < ends[s])) {
        this.copying ??= this.copy(ends).finally(() => { delete this.copying; });
        await this.copying;
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('history_unavailable', 'PostgreSQL task history is unavailable. Retry after reconnecting.', 503);
    }
  }

  private async page(id: string, stream: Stream, after: number, limit: number, exact = false) {
    if (await this.source.hasTask(id)) {
      await this.flush();
    } else {
      // An archived task can still serve its central history without its local task record.
      const exists = await this.pool.query(`SELECT 1 FROM public.task_runs WHERE owner_id=$1 AND task_id=$2
        UNION ALL SELECT 1 FROM public.task_history WHERE owner_id=$1 AND task_id=$2 LIMIT 1`, [this.owner, id])
        .catch(() => { throw new AppError('history_unavailable', 'PostgreSQL task history is unavailable', 503); });
      if (!exists.rowCount) throw new AppError('not_found', 'Unknown task', 404);
    }
    return this.pool.query(`SELECT sequence,kind,payload FROM public.task_history WHERE owner_id=$1 AND task_id=$2
      AND stream=$3 AND sequence ${exact ? '=' : '>'} $4 ORDER BY sequence LIMIT $5`, [this.owner, id, stream, after, limit])
      .catch(() => { throw new AppError('history_unavailable', 'PostgreSQL task history is unavailable', 503); });
  }
  async events(id: string, after: number, limit: number): Promise<TaskEvent[]> {
    const page = await this.page(id, 'events', after, limit);
    return page.rows.map(r => ({ ...r.payload, sequence: Number(r.sequence) }));
  }
  async evidence(id: string, after: number, limit: number, exact = false): Promise<Entry[]> {
    const page = await this.page(id, 'evidence', after, limit, exact);
    return page.rows.map(r => ({ ...r.payload, kind: r.kind, sequence: Number(r.sequence) }));
  }
  async evidenceEntry(id: string, sequence: number): Promise<Entry> {
    const [entry] = await this.evidence(id, sequence, 1, true);
    if (!entry) throw new AppError('not_found', 'Unknown evidence entry', 404);
    return entry;
  }
}
