import { AppError } from '../domain/errors.js';

export type LoginConfig = { mode: 'local' } | { mode: 'shared'; provider: 'password'; publicOrigin: string };

/** Deployment settings are deliberately separate from task/engine configuration. */
export function loginConfig(env: NodeJS.ProcessEnv = process.env): LoginConfig {
  const mode = env.DEVAGENTS_MODE || 'local';
  if (mode === 'local') {
    if (env.DEVAGENTS_AUTH_PROVIDER && env.DEVAGENTS_AUTH_PROVIDER !== 'local') throw new AppError('invalid_auth_config', 'Local mode uses local authentication');
    if (env.DEVAGENTS_PUBLIC_ORIGIN) throw new AppError('invalid_auth_config', 'DEVAGENTS_PUBLIC_ORIGIN requires shared mode');
    return { mode };
  }
  if (mode !== 'shared') throw new AppError('invalid_auth_config', 'DEVAGENTS_MODE must be local or shared');
  if (env.DEVAGENTS_AUTH_PROVIDER && env.DEVAGENTS_AUTH_PROVIDER !== 'password') throw new AppError('invalid_auth_config', 'Shared mode currently supports only the password login provider');
  let url: URL;
  try { url = new URL(env.DEVAGENTS_PUBLIC_ORIGIN ?? ''); }
  catch { throw new AppError('invalid_auth_config', 'Shared mode requires DEVAGENTS_PUBLIC_ORIGIN'); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new AppError('invalid_auth_config', 'Use an HTTPS public origin without a path, credentials, query or fragment; HTTP is allowed only on loopback');
  }
  return { mode, provider: 'password', publicOrigin: url.origin };
}
