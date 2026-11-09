import { constants } from 'node:fs';
import { lstat, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { availableDiskBytes, DATABASE_HEADROOM } from './disk-space.js';

export const EMERGENCY_RESERVE_BYTES = 64 * 1024 ** 2;
/** Service-owned, physically written blocks, released before persisting a storage failure. */
export class DiskReserve {
  private readonly path: string;
  private pending = Promise.resolve();
  constructor(dataDir: string) { this.path = join(dataDir, 'database-emergency-reserve'); }
  private serialize(work: () => Promise<void>): Promise<void> {
    const next = this.pending.then(work); this.pending = next.catch(() => {}); return next;
  }
  release(): Promise<void> { return this.serialize(() => this.releaseNow()); }
  replenish(): Promise<void> { return this.serialize(() => this.replenishNow()); }
  private async releaseNow(): Promise<void> {
    const s = await lstat(this.path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (!s) return;
    if (!s.isFile() || s.nlink !== 1) throw new Error('Emergency disk reserve is not a private regular file');
    await unlink(this.path);
  }
  private async replenishNow(): Promise<void> {
    const existing = await lstat(this.path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (existing?.isFile() && existing.nlink === 1 && existing.size === EMERGENCY_RESERVE_BYTES && existing.blocks * 512 >= EMERGENCY_RESERVE_BYTES) return;
    await this.releaseNow();
    if (await availableDiskBytes(dirname(this.path)) < DATABASE_HEADROOM + EMERGENCY_RESERVE_BYTES) return;
    const file = await open(this.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const chunk = Buffer.alloc(1024 ** 2);
      for (let offset = 0; offset < EMERGENCY_RESERVE_BYTES; offset += chunk.length) await file.writeFile(chunk);
      await file.sync();
    } catch (error) { await this.releaseNow(); throw error; }
    finally { await file.close(); }
  }
}
