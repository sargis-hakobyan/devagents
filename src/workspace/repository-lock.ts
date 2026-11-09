/** Coordinate only service-owned Git metadata operations; workers keep separate indexes. */
const pending = new Map<string, Promise<unknown>>();
export async function withRepositoryLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  const previous = pending.get(path) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(work); pending.set(path, current);
  try { return await current; } finally { if (pending.get(path) === current) pending.delete(path); }
}
