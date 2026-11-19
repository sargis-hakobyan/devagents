import { createHash } from 'node:crypto';
import { dirname, isAbsolute } from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import pg from 'pg';
import { AppError } from '../domain/errors.js';
import type { Task } from '../domain/schemas.js';
import type { TaskDiff } from '../workspace/diff.js';

export type SharedResult = { ownerId: string; task: Task; diff: TaskDiff | null };
export type TaskHandoff = { id: string; retryKey: string; fingerprint: string; claimId: string; snapshot: Task };
const unavailable = () => new AppError('shared_store_unavailable', 'Shared task storage is unavailable. Retry with the same submission key.', 503);

/** The trusted runtime binds this pool to one PostgreSQL login and one immutable workspace. */
export class PostgresTasks {
  private constructor(private readonly pool: pg.Pool, readonly ownerId: string) {}

  static async connect(config: pg.PoolConfig, ownerId: string) {
    const pool = new pg.Pool({ ...config, user: ownerId, max: 3, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
    pool.on('error', () => { /* Idle client failures are retried by the pool. */ });
    try {
      const check = await pool.query(`SELECT current_user AS login, r.rolsuper OR r.rolbypassrls AS privileged,
        t.relrowsecurity AND t.relforcerowsecurity AS protected
        FROM pg_roles r, pg_class t WHERE r.rolname=current_user AND t.oid='devagents.task_runs'::regclass`);
      const row = check.rows[0];
      if (row?.login !== ownerId || row.privileged || !row.protected) throw Error('Invalid workspace database configuration');
      return new PostgresTasks(pool, ownerId);
    } catch {
      await pool.end();
      throw new AppError('shared_store_config', 'Check the PostgreSQL schema, workspace login, and row security settings', 503);
    }
  }

  static async configured(ownerId: string) {
    const path = process.env.DEVAGENTS_POSTGRES_PASSWORD_FILE!;
    if (!isAbsolute(path) || dirname(await realpath(path)) !== '/run/secrets') throw new AppError('shared_store_config', 'Mount the PostgreSQL password as a file under /run/secrets');
    const password = (await readFile(path, 'utf8')).trimEnd();
    if (!password) throw new AppError('shared_store_config', 'The PostgreSQL password file is empty');
    return this.connect({ host: process.env.DEVAGENTS_POSTGRES_HOST, database: process.env.DEVAGENTS_POSTGRES_DATABASE ?? 'devagents', password }, ownerId);
  }

  async publish(job: TaskHandoff): Promise<void> {
    const retryHash = createHash('sha256').update(job.retryKey).digest('hex');
    try {
      const inserted = await this.pool.query(`INSERT INTO devagents.task_runs(owner_id,task_id,retry_hash,input_hash,submission)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT (owner_id,retry_hash) DO NOTHING`,
      [this.ownerId, job.id, retryHash, job.fingerprint, JSON.stringify(job.snapshot)]);
      if (inserted.rowCount === 1) return;
      const previous = await this.pool.query(`SELECT task_id FROM devagents.task_runs
        WHERE owner_id=$1 AND retry_hash=$2 AND task_id=$3 AND input_hash=$4`, [this.ownerId, retryHash, job.id, job.fingerprint]);
      if (previous.rowCount !== 1) throw new AppError('shared_task_conflict', 'Retry key already belongs to different work', 409);
    } catch (e) {
      if (e instanceof AppError) throw e;
      if (e instanceof pg.DatabaseError && e.code === '23505') throw new AppError('shared_task_conflict', 'Shared task ID already belongs to another submission', 409);
      throw unavailable();
    }
  }

  async claim(id: string, claimId: string): Promise<void> {
    // A worker retry can acknowledge its own claim after a crash between this commit and
    // opening the local dispatch gate. Another claimant or an archived task stays fenced.
    const claimed = await this.pool.query(`UPDATE devagents.task_runs SET claim_id=$3, claimed_at=COALESCE(claimed_at,now())
      WHERE owner_id=$1 AND task_id=$2 AND finished_at IS NULL AND (claim_id IS NULL OR claim_id=$3)
      RETURNING task_id`, [this.ownerId, id, claimId]).catch(() => { throw unavailable(); });
    if (claimed.rowCount !== 1) throw new AppError('shared_task_conflict', 'Shared submission or worker claim belongs to different work', 409);
  }

  async finish(id: string, claimId: string, result: SharedResult): Promise<void> {
    if (result.ownerId !== this.ownerId || result.task.id !== id) throw new AppError('shared_task_conflict', 'Result identity does not match its workspace claim', 409);
    const saved = await this.pool.query(`UPDATE devagents.task_runs SET result=COALESCE(result,$4::json), finished_at=COALESCE(finished_at,now())
      WHERE owner_id=$1 AND task_id=$2 AND claim_id=$3 RETURNING task_id`, [this.ownerId, id, claimId, JSON.stringify(result)]).catch(() => { throw unavailable(); });
    if (saved.rowCount !== 1) throw new AppError('shared_task_conflict', 'Shared task result requires the original workspace and claim', 409);
  }
  async result(id: string): Promise<SharedResult | undefined> {
    const rows = await this.pool.query('SELECT result FROM devagents.task_runs WHERE owner_id=$1 AND task_id=$2 AND result IS NOT NULL', [this.ownerId, id]).catch(() => { throw unavailable(); });
    return rows.rows[0]?.result;
  }
  close() { return this.pool.end(); }
}
