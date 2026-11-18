import { z } from 'zod';

/**
 * A ticket in Jira or in a ticket tool, as a task refers to it and as DevAgents reads it. The ticket
 * stays the source of truth: a task keeps the text it was started with and the link back, and files
 * of the ticket are kept only while the task works.
 */
export const TicketKey = z.string().min(1).max(60).regex(/^[^\s\x00-\x1f\x7f]+$/, 'Use the ticket number as the tool shows it');
/** `source` is `jira` or the ID of an added ticket tool. */
export const TicketSource = z.union([z.literal('jira'), z.uuid()]);
/** Sent with a submission that was started from a ticket. The service checks the source against the project and fills in the rest. */
export const TicketRef = z.strictObject({
  source: TicketSource, key: TicketKey,
  url: z.string().max(500).regex(/^https?:\/\/[^\s]+$/, 'Use an http or https link').optional(),
  /** When the ticket text in the request was read. */
  readAt: z.iso.datetime().optional(),
});
export type TicketRef = z.infer<typeof TicketRef>;
/** What a task records about its ticket. `name` is what the user calls the source, for example "Jira". */
export type TaskTicket = { source: string; name: string; key: string; url?: string; readAt?: string };

export type TicketComment = { /** Who wrote it, as the tool names them. */ by?: string; at?: string; body: string };
/** A file on a ticket. `url` is where the tool serves it; it is used for downloading only and never shown or stored. */
export type TicketFile = { name: string; type?: string; size?: number; url?: string };
/** One ticket as read from its tool. Remote text: shown and passed on as plain text only. */
export type TicketContent = {
  key: string; title: string; url?: string; description: string;
  /** Oldest first. */
  comments: TicketComment[]; files: TicketFile[];
};
/** How much of a ticket is read. A ticket is context for one task, not an archive. */
export const TICKET_LIMITS = { description: 12000, comment: 3000, comments: 50, files: 20 } as const;
/** A file of a ticket that DevAgents keeps for a working task. `file` is its name in the task's own folder. */
export type SavedTicketFile = { name: string; file: string; kind: 'image' | 'text'; type: string; bytes: number };
/** What was fetched for a task and what was left on the ticket, with the reason in plain words. */
export type TicketFiles = { saved: SavedTicketFile[]; skipped: { name: string; reason: string }[] };
/** Only what a team can use is fetched: pictures an engine can look at and short text. Everything else stays on the ticket. */
export const TICKET_FILE_LIMITS = { files: 8, imageBytes: 4 * 1024 * 1024, textBytes: 64 * 1024 } as const;
const PICTURES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const TEXT_FILES = new Set(['txt', 'md', 'log', 'json', 'csv', 'yml', 'yaml']);
/** Whether a file of a ticket is a picture or short text, by its declared type and its name. Anything else is not fetched. */
export function ticketFileKind(file: Pick<TicketFile, 'name' | 'type'>): { kind: 'image' | 'text'; type: string; extension: string } | undefined {
  const ext = /\.([A-Za-z0-9]{1,5})$/.exec(file.name)?.[1]?.toLowerCase() ?? ''; const declared = file.type?.toLowerCase().split(';')[0]?.trim() ?? '';
  const image = Object.values(PICTURES).includes(declared) ? declared : PICTURES[ext];
  if (image) return { kind: 'image', type: image, extension: Object.keys(PICTURES).find(key => PICTURES[key] === image)! };
  if (TEXT_FILES.has(ext) || declared === 'text/plain' || declared === 'text/markdown') return { kind: 'text', type: 'text/plain', extension: 'txt' };
  return;
}
