import { AppError } from '../domain/errors.js';

export type Fetch = typeof fetch;
const LIMIT = 2 * 1024 * 1024;

export type RemoteResponse = { status: number; headers: Headers; json: unknown; /** The raw body, for answers that are not one JSON document. */ body: string };
/**
 * One bounded request to an integration host. Redirects are not followed, so a token is only ever
 * sent to the address that was configured. The response body is remote content: callers pick the
 * fields they need and never pass it on wholesale.
 */
export async function remote(fetcher: Fetch, service: string, url: string, init: { method?: string; headers: Record<string, string>; body?: unknown }): Promise<RemoteResponse> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: init.method ?? 'GET', redirect: 'manual', signal: AbortSignal.timeout(10000),
      headers: { accept: 'application/json', ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...init.headers },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch { throw new AppError('integration_unavailable', `${service} could not be reached. Check the address and your network, then try again.`, 502); }
  if (response.status >= 300 && response.status < 400) throw new AppError('integration_redirected', `${service} answered with a redirect. Enter the final https address.`, 502);
  const text = await response.text().catch(() => '');
  if (text.length > LIMIT) throw new AppError('integration_unavailable', `${service} sent an unexpectedly large answer.`, 502);
  let json: unknown;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  if (response.status >= 500) throw new AppError('integration_unavailable', `${service} is not answering right now (${response.status}). Try again later.`, 502);
  return { status: response.status, headers: response.headers, json, body: text };
}
export const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
/** Remote text is shown to the user as plain text; keep it short and on one line. */
export const text = (value: unknown, limit = 200): string => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';
