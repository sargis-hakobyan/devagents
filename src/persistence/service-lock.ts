import { join } from 'node:path';
import { PgSession } from './pg-session.js';
import { AppError } from '../domain/errors.js';

/** One runtime per workspace. PostgreSQL releases its session lock when the process exits. */
export async function lockService(dataDir: string): Promise<() => Promise<void>> {
  const db = await PgSession.open(join(dataDir, 'devagents.db'), true);
  try {
    const row = await db.prepare('SELECT pg_try_advisory_lock(hashtextextended(workspace_context()::text, 1)) AS acquired').get();
    if (!row?.acquired) throw new AppError('service_in_use', 'Another service owns this data directory');
    return async () => await db.close();
  } catch (error) { await db.close(); throw error; }
}
