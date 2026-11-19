import type { IncomingMessage } from 'node:http';
import { AppError } from '../domain/errors.js';

export async function body(req: IncomingMessage, limit = 256 * 1024): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError('invalid_content_type', 'Use application/json', 415);
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new AppError('body_too_large', 'Request exceeds the allowed size', 413);
    chunks.push(chunk as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AppError('invalid_json', 'Invalid JSON request'); }
}
