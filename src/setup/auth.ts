import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../domain/errors.js';
import type { AuthStatus } from '../domain/auth.js';
import { codexAuthStatus, setupCodexAuth } from '../engines/codex/setup.js';
import { loginWithChatGPT, type DeviceChallenge } from '../engines/codex/device-login.js';

export const AuthInput = z.object({ attemptId: z.uuid(), method: z.enum(['chatgpt', 'api-key']), apiKey: z.string().min(1).max(4096).regex(/^\S+$/, 'Enter one API key without whitespace').optional() }).strict().superRefine((v, c) => {
  if ((v.method === 'api-key') !== (v.apiKey !== undefined)) c.addIssue({ code: 'custom', message: 'An API key is required only for API-key sign-in' });
});
export type AuthJob = { attemptId: string; method: 'chatgpt' | 'api-key'; state: 'running' | 'completed' | 'failed' | 'cancelled'; challenge?: DeviceChallenge; message: string };
export interface SetupAuthDriver {
  status(): Promise<AuthStatus>;
  login(method: 'chatgpt' | 'api-key', key: string | undefined, signal: AbortSignal, challenge: (value: DeviceChallenge) => void): Promise<void>;
}
export function codexSetupDriver(dataDir: string): SetupAuthDriver {
  return {
    status: () => codexAuthStatus(dataDir),
    login: async (method, key, signal, challenge) => {
      if (method === 'chatgpt') await loginWithChatGPT(dataDir, { signal, onChallenge: challenge });
      else await setupCodexAuth(dataDir, { replaceKey: true, readKey: async () => key!, signal });
    },
  };
}
/** One ephemeral login, owned by its authenticated session. No credentials or output enter task storage. */
export class SetupAuth {
  private current: { owner: string; fingerprint: string; job: AuthJob; abort: AbortController; done: Promise<void>; expires: number } | undefined;
  constructor(private readonly driver: SetupAuthDriver, private readonly assertIdle: () => void = () => {}) {}
  private stopped = false;
  revision = 0;
  get busy() { return this.current?.job.state === 'running'; }
  async status(owner: string) {
    if (this.current && !this.busy && Date.now() > this.current.expires) this.current = undefined;
    let connection: AuthStatus = { saved: false }; let locked = false; let unavailable = false;
    try { connection = await this.driver.status(); } catch (e) { locked = e instanceof AppError && e.code === 'vault_locked'; unavailable = !locked; }
    return { available: true, connection, locked, unavailable, busy: this.busy, ...(this.current?.owner === owner ? { job: this.view() } : {}) };
  }
  private view(): AuthJob { return structuredClone(this.current!.job); }
  start(owner: string, input: unknown): AuthJob {
    if (this.stopped) throw new AppError('setup_unavailable', 'The service is shutting down.', 503);
    const parsed = AuthInput.parse(input);
    const fingerprint = createHash('sha256').update(JSON.stringify([parsed.method, parsed.apiKey])).digest('hex');
    if (this.current?.owner === owner && this.current.job.attemptId === parsed.attemptId) {
      if (this.current.fingerprint !== fingerprint) throw new AppError('attempt_conflict', 'This sign-in attempt has different input. Start a new attempt.', 409);
      return this.view();
    }
    if (this.busy) throw new AppError('setup_busy', 'Another sign-in is in progress. Finish or cancel it first.', 409);
    this.assertIdle();
    const current = { owner, fingerprint, job: { attemptId: parsed.attemptId, method: parsed.method, state: 'running', message: 'Starting sign-in…' } as AuthJob, abort: new AbortController(), done: Promise.resolve(), expires: Date.now() + 10 * 60 * 1000 };
    this.current = current;
    const timer = setTimeout(() => current.abort.abort(), 10 * 60 * 1000);
    current.done = (async () => {
      try {
        await this.driver.login(parsed.method, parsed.apiKey, current.abort.signal, challenge => {
          if (!current.abort.signal.aborted) { current.job.challenge = challenge; current.job.message = 'Open the official sign-in page and enter this one-time code. Do not share the code.'; }
        });
        const status = await this.driver.status();
        if (current.abort.signal.aborted) throw new AppError('cancelled', 'Sign-in stopped.');
        if (!status.saved || status.method !== parsed.method) throw new AppError('login_unverified', 'Sign-in was not confirmed.');
        current.job.state = 'completed'; current.job.message = 'Connection saved securely. Model access has not been tested.';
      } catch {
        current.job.state = current.abort.signal.aborted ? 'cancelled' : 'failed';
        current.job.message = current.abort.signal.aborted ? 'Sign-in stopped. Check the saved connection before retrying.' : 'Sign-in could not finish. Check the runtime and unlocked credential store. For ChatGPT, enable device code sign-in in Security settings, then try again.';
      } finally { this.revision++; clearTimeout(timer); parsed.apiKey = undefined; delete current.job.challenge; }
    })();
    return this.view();
  }
  async cancel(owner: string) {
    if (!this.current || this.current.owner !== owner) throw new AppError('not_found', 'No sign-in attempt for this session.', 404);
    const current = this.current; current.abort.abort(); await current.done; return structuredClone(current.job);
  }
  async close() { this.stopped = true; if (this.current) { this.current.abort.abort(); await this.current.done; } }
}
