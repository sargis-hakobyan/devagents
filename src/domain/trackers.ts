import { z } from 'zod';
import type { IntegrationProblem } from './integrations.js';

/**
 * A tracker is any ticket tool that offers an MCP server, added once and then usable by every
 * project. DevAgents does not know the tool: a mapping says which of the server's tools lists
 * tickets and where the ticket fields are in its answer. Like the other integrations this is
 * configuration only; nothing turns tickets into tasks yet.
 */
export const TrackerId = z.uuid();
export const TrackerName = z.string().trim().min(1).max(60).regex(/^[^\x00-\x1f\x7f]+$/, 'Use a name without control characters');
const Token = z.string().min(8).max(4096).regex(/^\S+$/, 'Enter one token without whitespace');
/** Name of a tool or argument as the MCP server declares it. */
const Identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.\-/]+$/, 'Use the name exactly as the server declares it');
/** Where a value sits inside an answer: field names joined by dots, for example `data.tasks`. */
export const FieldPath = z.string().min(1).max(200).regex(/^[A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+)*$/, 'Use field names joined by dots, for example data.tasks');
/** An argument of the list tool that takes a rule value; `many` when the server expects a list. */
const Argument = z.strictObject({ name: Identifier, many: z.boolean().default(false) });
const Fixed = z.union([z.string().max(500), z.number(), z.boolean(), z.array(z.string().max(500)).max(50)]);

export const TrackerMapping = z.strictObject({
  list: z.strictObject({
    tool: Identifier,
    /** Arguments sent with every call, for example `{"assignment":"all"}` where the tool defaults to the caller's own tickets. */
    fixed: z.record(Identifier, Fixed).refine(v => Object.keys(v).length <= 20, 'Use at most 20 fixed arguments').default({}),
    /** Rule values the server can filter by itself. Anything not named here is filtered by DevAgents after the call. */
    filters: z.strictObject({ project: Argument.optional(), column: Argument.optional(), label: Argument.optional(), assignee: Argument.optional() }).default({}),
  }),
  /** Where the answer of the list tool holds the tickets and, when it has them, the things a rule can name. */
  result: z.strictObject({ tickets: FieldPath, projects: FieldPath.optional(), labels: FieldPath.optional(), people: FieldPath.optional(), account: FieldPath.optional() }),
  /** Fields of one ticket. */
  ticket: z.strictObject({ key: FieldPath, title: FieldPath, column: FieldPath.optional(), project: FieldPath.optional(), assignee: FieldPath.optional(), labels: FieldPath.optional(), url: FieldPath.optional() }),
  /** Columns a rule can name, in board order. Left empty, the columns seen on tickets are offered. */
  columns: z.array(z.string().min(1).max(100)).max(100).default([]),
});
export type TrackerMapping = z.infer<typeof TrackerMapping>;

export const TrackerAddInput = z.strictObject({ name: TrackerName, url: z.string().min(1).max(500), token: Token.optional() });
export const TrackerUpdateInput = z.strictObject({ name: TrackerName.optional(), url: z.string().min(1).max(500).optional(), token: Token.optional() }).refine(v => v.name !== undefined || v.url !== undefined || v.token !== undefined, { message: 'Send a new name, address or token' });
export const TrackerRuleInput = z.strictObject({
  /** Project, column and person by id or exact name, as the options call lists them. */
  project: z.string().min(1).max(200).optional(), column: z.string().min(1).max(100).optional(),
  assignee: z.string().min(1).max(320).optional(), label: z.string().min(1).max(255).optional(),
  start: z.enum(['manual', 'auto']).default('manual'),
}).refine(v => v.column || v.assignee || v.label, { message: 'Choose a column, an assignee or a label, so the rule cannot mean every ticket' });

/** `match` lists every value a ticket may use to refer to this entry (its id, key, email or name), lowercased. */
export type TrackerChoice = { id: string; name: string; match?: string[] };
export type Tracker = {
  id: string; name: string; url: string;
  /** Name the token is stored under; never the token. */
  savedToken: string;
  /** What the server calls itself. Remote text, shown as plain text only. */
  server: { name: string; version: string };
  /** Signed-in account, when the mapping says where the answer names it. */
  account?: string;
  mapping?: TrackerMapping;
  connectedAt: string; checkedAt: string; problem?: IntegrationProblem;
};
export type TrackerRule = { project?: TrackerChoice; column?: string; assignee?: TrackerChoice; label?: string; start: 'manual' | 'auto'; savedAt: string };
/** A project's use of one tracker. The tracker itself, with its address and token, is shared. */
export type TrackerConnection = { trackerId: string; connectedAt: string; rule?: TrackerRule };
export type TrackerTicket = { key: string; title: string; column?: string; project?: string; assignee?: string; labels: string[]; url?: string };
