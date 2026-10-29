import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { z, ZodError } from 'zod';
import type { TaskService } from '../orchestration/service.js';
import { AppError } from '../domain/errors.js';
import { environmentSecrets, redactValues, log } from '../telemetry/redact.js';

export async function accessToken(dataDir: string): Promise<string> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, 'api-token');
  try { await writeFile(path, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await chmod(path, 0o600);
  return (await readFile(path, 'utf8')).trim();
}
async function body(req: IncomingMessage): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError('invalid_content_type', 'Use application/json', 415);
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 256 * 1024) throw new AppError('body_too_large', 'Request exceeds 256KB', 413);
    chunks.push(chunk as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AppError('invalid_json', 'Invalid JSON request'); }
}
function send(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  // Stored rows are already redacted at rest; responses only strip secret values so plans stay readable.
  res.end(JSON.stringify(redactValues(data, environmentSecrets())));
}
export function createApi(service: TaskService, token: string) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { status: 'ok', milestone: 'M3', executionEnabled: service.executionEnabled });
      // Prevent browser-origin requests, including cross-site requests to localhost.
      if (req.headers.origin) throw new AppError('forbidden_origin', 'Browser requests are not enabled', 403);
      const supplied = Buffer.from(req.headers.authorization ?? ''); const expected = Buffer.from(`Bearer ${token}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new AppError('unauthorized', 'Use the local CLI or a valid bearer token', 401);
      const path = url.pathname;
      if (req.method === 'GET' && path === '/projects') return send(res, 200, service.store.projects());
      if (req.method === 'POST' && path === '/projects') return send(res, 201, await service.registerProject(await body(req)));
      if (req.method === 'GET' && path === '/agents') return send(res, 200, await service.agents(url.searchParams.get('projectId') ?? undefined));
      if (req.method === 'GET' && path === '/tasks') return send(res, 200, service.store.summaries());
      if (req.method === 'POST' && path === '/tasks') {
        const key = z.string().min(1).max(200).parse(req.headers['idempotency-key']);
        return send(res, 201, service.submit(await body(req), key));
      }
      const match = /^\/tasks\/([a-f0-9-]{36})(?:\/(events|evidence|items|run|mode|plan|approve|cancel|cleanup))?$/.exec(path);
      if (match) {
        const id = match[1]!; const action = match[2];
        if (req.method === 'GET' && !action) return send(res, 200, service.store.task(id));
        if (req.method === 'GET' && action === 'events') return send(res, 200, service.store.events(id));
        if (req.method === 'GET' && action === 'evidence') return send(res, 200, service.store.evidence(id));
        if (req.method === 'GET' && action === 'items') return send(res, 200, service.store.workItems(id));
        if (req.method === 'POST') {
          if (action === 'run') return send(res, 202, service.run(id));
          if (action === 'mode') return send(res, 200, service.mode(id, z.strictObject({ mode: z.unknown() }).parse(await body(req)).mode));
          if (action === 'plan') return send(res, 200, await service.proposePlan(id, await body(req)));
          if (action === 'approve') return send(res, 200, service.approve(id, z.strictObject({ version: z.number().int().nonnegative() }).parse(await body(req)).version));
          if (action === 'cancel') return send(res, 200, service.cancel(id));
          if (action === 'cleanup') return send(res, 200, await service.cleanup(id));
        }
      }
      throw new AppError('not_found', 'Unknown endpoint', 404);
    } catch (error) {
      if (error instanceof ZodError) return send(res, 400, { error: 'validation_error', message: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
      if (error instanceof AppError) return send(res, error.status, { error: error.code, message: error.message });
      log('request_failed', { message: error instanceof Error ? error.message : String(error) });
      send(res, 500, { error: 'internal_error', message: 'Request failed; inspect the service log' });
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  return server;
}
