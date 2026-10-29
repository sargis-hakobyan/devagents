import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../domain/errors.js';

/** SQLite's OS lock is released after a crash, unlike PID files in recreated containers. */
export function lockService(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dataDir, 'service-lock.db'));
  try { db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;'); }
  catch { db.close(); throw new AppError('service_in_use', 'Another service owns this data directory'); }
  return () => { db.exec('ROLLBACK'); db.close(); };
}
