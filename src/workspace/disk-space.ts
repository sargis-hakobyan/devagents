import { statfs } from 'node:fs/promises';
import { AppError } from '../domain/errors.js';

export const DEFAULT_PREPARATION_HEADROOM = 5 * 1024 ** 3;
export const DATABASE_HEADROOM = 256 * 1024 ** 2;
/** Use available blocks, not root-reserved free blocks (the service runs unprivileged). */
export async function availableDiskBytes(path: string): Promise<number> {
  const fs = await statfs(path);
  return fs.bavail * fs.bsize;
}
export async function assertDiskSpace(path: string, required = DEFAULT_PREPARATION_HEADROOM, read = availableDiskBytes): Promise<void> {
  const available = await read(path);
  if (available < required) throw new AppError('disk_space_low', `Insufficient disk space: ${Math.floor(available / 1024 ** 2)} MiB available; ${Math.ceil(required / 1024 ** 2)} MiB required. Compact finished tasks or free space before starting more work.`, 507);
}
