import { AppError } from '../domain/errors.js';
import { git } from './git.js';

export const ORIGINAL_STATUS_TIMEOUT_MS = 120000;
/** The full source checkout can be large and cross a Docker bind mount. Never skip its check. */
export async function originalCheckoutStatus(cwd: string, options: {
  signal?: AbortSignal; timeoutMs?: number; onRetry?: (message: string) => void;
} = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? ORIGINAL_STATUS_TIMEOUT_MS;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await git(cwd, ['status', '--porcelain=v1', '--untracked-files=all'], true, 2 * 1024 * 1024, {
        timeoutMs, optionalLocks: false, ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'git_timeout') throw error;
      if (options.signal?.aborted) throw new AppError('cancelled', 'Original checkout scan cancelled');
      if (attempt === 2) throw new AppError('git_timeout', `Original checkout status scan timed out after 2 attempts (${timeoutMs / 1000} seconds each) in ${cwd}. Check repository or Docker filesystem responsiveness. The checkout check was not bypassed.`);
      options.onRetry?.(`Original checkout status scan timed out after ${timeoutMs / 1000} seconds; retrying once (attempt 2 of 2).`);
    }
  }
  throw new Error('Unreachable status scan state');
}
