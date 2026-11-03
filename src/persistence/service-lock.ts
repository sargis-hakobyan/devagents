import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../domain/errors.js';

/** SQLite's OS lock is released after a crash, unlike PID files in recreated containers. */
export function lockService(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dataDir, 'service-lock.db'));
  try { db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;'); }
  catch (error) {
    db.close();
    // SQLite extended result codes keep the primary result in the low byte.
    const code = error && typeof error === 'object' && 'errcode' in error && typeof error.errcode === 'number'
      ? error.errcode & 0xff : undefined;
    if (code === 5 || code === 6) throw new AppError('service_in_use', 'Another service owns this data directory');
    if (code === 13) throw new AppError('disk_space_low', 'Cannot acquire the service lock: the data disk is full. Free space on the data volume or increase Docker disk capacity, then restart DevAgents.', 507);
    throw error;
  }
  return () => { db.exec('ROLLBACK'); db.close(); };
}
