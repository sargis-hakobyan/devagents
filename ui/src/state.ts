import { useEffect, useState } from 'preact/hooks';
import { SignedOutError } from './api';

/** Connection state shared by every poller: last successful contact and the current retry schedule. */
export type Connection = { online: boolean; lastUpdate?: Date; attempt: number; nextRetryAt?: number; error?: string };
let connection: Connection = { online: true, attempt: 0 };
const connectionListeners = new Set<(c: Connection) => void>();
function publish(next: Connection) { connection = next; for (const l of connectionListeners) l(next); }
export function useConnection(): Connection {
  const [c, setC] = useState(connection);
  useEffect(() => { connectionListeners.add(setC); return () => { connectionListeners.delete(setC); }; }, []);
  return c;
}
function reportSuccess() { publish({ online: true, attempt: 0, lastUpdate: new Date() }); }
function reportFailure(error: string) {
  const attempt = connection.attempt + 1; const delay = Math.min(2000 * 2 ** (attempt - 1), 30000);
  publish({ online: false, attempt, nextRetryAt: Date.now() + delay, error, ...(connection.lastUpdate ? { lastUpdate: connection.lastUpdate } : {}) });
}
export let onSignedOut: () => void = () => { location.assign('/ui/signed-out'); };
export function setSignedOutHandler(handler: () => void) { onSignedOut = handler; }

type Snapshot<T> = { data: T | undefined; error: string | undefined; loading: boolean };
type Poller<T> = { snapshot: Snapshot<T>; subscribers: Set<(s: Snapshot<T>) => void>; timer?: ReturnType<typeof setTimeout> | undefined; running: boolean; load: () => Promise<T>; intervalMs: number; generation: number };
const pollers = new Map<string, Poller<unknown>>();
/** Every active poller retries immediately; used by the banner's "Retry now". */
export function retryNow() { for (const p of pollers.values()) if (p.subscribers.size) schedule(p, 0); }

function schedule<T>(p: Poller<T>, delay: number) {
  if (p.timer) clearTimeout(p.timer);
  p.timer = setTimeout(() => { void run(p); }, delay);
}
async function run<T>(p: Poller<T>) {
  if (p.running || !p.subscribers.size) return;
  p.running = true; const generation = p.generation;
  try {
    const data = await p.load();
    if (generation !== p.generation) return;
    p.snapshot = { data, error: undefined, loading: false }; reportSuccess();
    for (const s of p.subscribers) s(p.snapshot);
    schedule(p, p.intervalMs);
  } catch (e) {
    if (generation !== p.generation) return;
    if (e instanceof SignedOutError) { onSignedOut(); return; }
    const message = e instanceof Error ? e.message : String(e);
    p.snapshot = { ...p.snapshot, error: message, loading: false }; reportFailure(message);
    for (const s of p.subscribers) s(p.snapshot);
    schedule(p, Math.max(0, (connection.nextRetryAt ?? Date.now()) - Date.now()));
  } finally { p.running = false; }
}
/**
 * Bounded polling shared by every subscriber of `key`: one request per interval however many
 * components show the data. Failures back off exponentially (2 s to 30 s) and keep the last good
 * data, so nothing is invented while disconnected. A 401 ends the session everywhere. Polling
 * stops when the last subscriber unmounts; a `key` change resets the poller.
 */
export function usePoll<T>(key: string, load: () => Promise<T>, intervalMs: number): Snapshot<T> & { reload: () => void } {
  const existing = pollers.get(key) as Poller<T> | undefined;
  const [snapshot, setSnapshot] = useState<Snapshot<T>>(existing?.snapshot ?? { data: undefined, error: undefined, loading: true });
  useEffect(() => {
    let p = pollers.get(key) as Poller<T> | undefined;
    if (!p) { p = { snapshot: { data: undefined, error: undefined, loading: true }, subscribers: new Set(), running: false, load, intervalMs, generation: 0 }; pollers.set(key, p as Poller<unknown>); }
    else { p.load = load; p.intervalMs = intervalMs; }
    p.subscribers.add(setSnapshot); setSnapshot(p.snapshot);
    if (p.subscribers.size === 1) schedule(p, 0);
    return () => {
      p!.subscribers.delete(setSnapshot);
      if (p!.subscribers.size === 0) { if (p!.timer) clearTimeout(p!.timer); p!.timer = undefined; p!.generation++; p!.running = false; }
    };
  }, [key, intervalMs]);
  return { ...snapshot, reload: () => { const p = pollers.get(key); if (p) schedule(p, 0); } };
}
/** Drops a poller's cached data, for example after a key is reused for a different task. */
export function forget(key: string) { const p = pollers.get(key); if (p) { p.generation++; if (p.timer) clearTimeout(p.timer); pollers.delete(key); } }
export function useNow(everyMs = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), everyMs); return () => clearInterval(t); }, [everyMs]);
  return now;
}
