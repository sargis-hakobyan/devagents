import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import type { ServerResponse } from 'node:http';
import { isWithin } from '../workspace/paths.js';

/** Headers every response from the local service carries; the UI bundle is the only script source. */
export const securityHeaders: Record<string, string> = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json; charset=utf-8', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
};
/**
 * Serves the built UI from `root`. `/ui/assets/*` maps to hashed files (long cache); every other
 * `/ui` path returns the shell so the client router can take over. Paths never escape `root`.
 */
export async function serveUi(root: string | undefined, urlPath: string, res: ServerResponse): Promise<void> {
  const end = (code: number, body: Buffer | string, type: string, cache: string) => {
    res.writeHead(code, { ...securityHeaders, 'content-type': type, 'cache-control': cache, 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };
  if (!root) return end(503, JSON.stringify({ error: 'ui_unavailable', message: 'The browser UI bundle is not built; run npm run build' }), 'application/json', 'no-store');
  const asset = urlPath.startsWith('/ui/assets/');
  const relative = asset ? urlPath.slice('/ui/'.length) : 'index.html';
  if (relative.includes('\0') || relative.split('/').some(s => s === '..')) return end(404, 'Not found', 'text/plain', 'no-store');
  const canonicalRoot = await realpath(root);
  const target = resolve(canonicalRoot, relative);
  if (!isWithin(canonicalRoot, target)) return end(404, 'Not found', 'text/plain', 'no-store');
  try {
    const info = await stat(target);
    if (!info.isFile()) return end(404, 'Not found', 'text/plain', 'no-store');
    const body = await readFile(target);
    const type = types[extname(target).toLowerCase()] ?? 'application/octet-stream';
    end(200, body, type, asset ? 'public, max-age=31536000, immutable' : 'no-store');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return end(404, 'Not found', 'text/plain', 'no-store');
    throw error;
  }
}
export async function findUiRoot(candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    try { if ((await stat(join(candidate, 'index.html'))).isFile()) return candidate; } catch { /* next */ }
  }
  return undefined;
}
