import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from '../domain/errors.js';
import { TICKET_FILE_LIMITS, ticketFileKind, type SavedTicketFile, type TaskTicket, type TicketFile, type TicketFiles } from '../domain/tickets.js';
import type { Fetch } from './http.js';
import { ticketContent, type TicketSources } from './tickets.js';

/** Where a source serves its files from, and the sign-in they need. The sign-in is sent to those hosts only. */
export type FileAccess = { name: string; origins: string[]; authorization: string; fetch: Fetch; /** Jira Cloud hands a file over through one redirect to its storage host. */ redirects?: boolean };

/** A picture must be what its name says: an engine refuses a file whose content is something else. */
function looksLike(type: string, bytes: Buffer): boolean {
  if (type === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (type === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === 'image/gif') return bytes.subarray(0, 4).toString('latin1') === 'GIF8';
  if (type === 'image/webp') return bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP';
  return false;
}
const readable = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** One file, read up to a limit. Where the source is known to redirect to a storage host, that is followed once and without the sign-in. */
async function fetchFile(access: FileAccess, url: string, limit: number): Promise<Buffer> {
  const unreachable = () => new AppError('integration_unavailable', `${access.name} could not be reached.`, 502);
  const get = (address: string, signedIn: boolean) => access.fetch(address, { redirect: 'manual', signal: AbortSignal.timeout(30000), headers: signedIn ? { authorization: access.authorization } : {} }).catch(() => { throw unreachable(); });
  let response = await get(url, true);
  if (access.redirects && [301, 302, 303, 307, 308].includes(response.status)) {
    const next = response.headers.get('location');
    if (!next || !/^https:\/\//.test(next)) throw new AppError('integration_redirected', `${access.name} sent the file somewhere that cannot be followed.`, 502);
    response = await get(next, false);
  }
  if (response.status === 401 || response.status === 403) throw new AppError('token_rejected', `${access.name} did not allow the file to be read (${response.status}).`, 422);
  if (response.status !== 200 || !response.body) throw new AppError('integration_unavailable', `${access.name} answered ${response.status} for the file.`, 502);
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > limit) throw new AppError('file_skipped', `it is larger than ${readable(limit)}`, 422);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** One file of a ticket, checked before and after it is fetched. A file that is not taken says why, in words that follow its name. */
async function fetchTicketFile(access: FileAccess, file: TicketFile): Promise<{ kind: 'image' | 'text'; type: string; extension: string; bytes: Buffer }> {
  const skip = (reason: string) => new AppError('file_skipped', reason, 422);
  const kind = ticketFileKind(file);
  if (!kind) throw skip('only pictures and short text files are passed to the team');
  const limit = kind.kind === 'image' ? TICKET_FILE_LIMITS.imageBytes : TICKET_FILE_LIMITS.textBytes;
  if (file.size !== undefined && file.size > limit) throw skip(`it is larger than ${readable(limit)}`);
  let address: URL | undefined; try { address = file.url ? new URL(file.url) : undefined; } catch { address = undefined; }
  if (!address) throw skip(`${access.name} gave no link for it`);
  if (!access.origins.includes(address.origin)) throw skip(`it is served from another host (${address.host})`);
  const bytes = await fetchFile(access, address.href, limit);
  if (kind.kind === 'image' && !looksLike(kind.type, bytes)) throw skip('its content is not the picture its name says');
  if (kind.kind === 'text' && (bytes.includes(0) || !Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes))) throw skip('it is not plain text');
  return { ...kind, bytes };
}
const accessFor = (sources: TicketSources, projectId: string, source: string): Promise<FileAccess> => source === 'jira' ? sources.integrations!.jiraFileAccess(projectId) : sources.trackers!.fileAccess(source);
/**
 * One picture of a ticket, for showing it in the submit form before any task exists. It is read from
 * the tool on request, under the same rules as a task's files, and is not kept.
 */
export async function ticketPicture(sources: TicketSources, projectId: string, source: string, key: string, index: number): Promise<{ type: string; bytes: Buffer }> {
  const { content } = await ticketContent(sources, projectId, source, key); const file = content.files[index];
  if (!file || ticketFileKind(file)?.kind !== 'image') throw new AppError('not_found', 'This ticket has no picture there', 404);
  try { const { type, bytes } = await fetchTicketFile(await accessFor(sources, projectId, source), file); return { type, bytes }; }
  catch (error) { if (error instanceof AppError && error.code === 'file_skipped') throw new AppError('file_skipped', `${file.name} cannot be shown: ${error.message}.`, 422); throw error; }
}

/**
 * Fetches the files of a task's ticket into the task's own folder. The ticket is read again first,
 * because tools hand out file links that stop working after a few minutes. Only pictures and short
 * text are fetched, only from the tool's own host, and a file that cannot be fetched is named with
 * the reason instead of stopping the task.
 */
export async function downloadTicketFiles(sources: TicketSources, projectId: string, ticket: TaskTicket, directory: string): Promise<TicketFiles> {
  const { content } = await ticketContent(sources, projectId, ticket.source, ticket.key);
  const saved: SavedTicketFile[] = []; const skipped: TicketFiles['skipped'] = [];
  if (!content.files.length) return { saved, skipped };
  const access = await accessFor(sources, projectId, ticket.source);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const file of content.files) {
    if (saved.length >= TICKET_FILE_LIMITS.files) { skipped.push({ name: file.name, reason: `a task takes at most ${TICKET_FILE_LIMITS.files} files` }); continue; }
    try {
      const fetched = await fetchTicketFile(access, file);
      const name = `${String(saved.length + 1).padStart(2, '0')}.${fetched.extension}`;
      await writeFile(join(directory, name), fetched.bytes, { mode: 0o600 });
      saved.push({ name: file.name, file: name, kind: fetched.kind, type: fetched.type, bytes: fetched.bytes.byteLength });
    } catch (error) { if (!(error instanceof AppError)) throw error; skipped.push({ name: file.name, reason: error.code === 'file_skipped' ? error.message : `it could not be fetched: ${error.message}` }); }
  }
  return { saved, skipped };
}
