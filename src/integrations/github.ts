import { AppError } from '../domain/errors.js';
import { git } from '../workspace/git.js';
import { record, remote, text, type Fetch } from './http.js';

export const GITHUB_API = 'https://api.github.com';

/** `owner/name` from a GitHub remote URL. Only these two parts are kept, so credentials embedded in a URL are never stored. */
export function repositoryFromRemote(url: string): string | undefined {
  const match = /^(?:https?:\/\/(?:[^@/\s]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : undefined;
}
/** The repository a registered folder was cloned from, read from its `origin` remote. */
export async function folderRepository(path: string): Promise<string | undefined> {
  try { return repositoryFromRemote(await git(path, ['config', '--get', 'remote.origin.url'], true, 64 * 1024, { timeoutMs: 5000, optionalLocks: false })); }
  catch { return undefined; }
}
export function tokenKind(token: string): 'fine-grained' | 'classic' | undefined {
  if (/^github_pat_[A-Za-z0-9_]{20,}$/.test(token)) return 'fine-grained';
  if (/^gh[pousr]_[A-Za-z0-9_]{20,}$/.test(token)) return 'classic';
  return undefined;
}
/** GitHub reports an end date as `2026-12-31 08:00:00 UTC` or with a numeric offset. */
export function tokenExpiry(header: string | null): string | undefined {
  if (!header) return;
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (UTC|[+-]\d{4})$/.exec(header.trim());
  if (!match) return;
  const time = Date.parse(`${match[1]}T${match[2]}${match[3] === 'UTC' ? 'Z' : `${match[3]!.slice(0, 3)}:${match[3]!.slice(3)}`}`);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}
export type GitHubCheck = { login: string; canPush: boolean | null; expiresAt?: string };
export async function verifyGitHub(fetcher: Fetch, apiUrl: string, token: string, repository: string): Promise<GitHubCheck> {
  const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'devagents' };
  const user = await remote(fetcher, 'GitHub', `${apiUrl}/user`, { headers });
  if (user.status === 401) throw new AppError('token_rejected', 'GitHub did not accept this token. It may be mistyped, expired or revoked.', 422);
  if (user.status !== 200) throw new AppError('integration_unavailable', `GitHub could not check this token (${user.status}). Try again later.`, 502);
  const login = text(record(user.json).login, 100);
  if (!login) throw new AppError('integration_unavailable', 'GitHub did not say which account this token belongs to.', 502);
  const repo = await remote(fetcher, 'GitHub', `${apiUrl}/repos/${repository}`, { headers });
  if (repo.status === 401) throw new AppError('token_rejected', 'GitHub did not accept this token. It may be mistyped, expired or revoked.', 422);
  if (repo.status !== 200) throw new AppError('not_reachable', `This token cannot see ${repository}. Give it access to that repository, or check the name.`, 422);
  const push = record(record(repo.json).permissions).push;
  const expiresAt = tokenExpiry(user.headers.get('github-authentication-token-expiration'));
  return { login, canPush: typeof push === 'boolean' ? push : null, ...(expiresAt ? { expiresAt } : {}) };
}
