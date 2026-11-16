import { z } from 'zod';

/**
 * Per-project GitHub and Jira connections. Only settings and the last check live here; a token is
 * write-only and stays in the secret store. Nothing in DevAgents acts on these connections yet:
 * they are stored and verified so publishing and ticket pick-up can build on them.
 */
const Token = z.string().min(8).max(4096).regex(/^\S+$/, 'Enter one token without whitespace');
export const GitHubRepository = z.string().max(140).regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/, 'Use owner/name');
/** Id of a token that is already saved for another project; it is the name the token is stored under, never the token. */
export const SavedTokenId = z.string().regex(/^(?:github|jira)-[a-z0-9-]{1,120}$/, 'Use a saved token id from the integrations view');
export const GitHubConnectInput = z.strictObject({ token: Token.optional(), savedToken: SavedTokenId.optional(), repository: GitHubRepository.optional() })
  .refine(v => !(v.token && v.savedToken), { message: 'Paste a token or choose a saved one, not both' });

export const JiraKind = z.enum(['cloud', 'data-center']);
export const JiraConnectInput = z.strictObject({
  /** With a saved token the site, kind and email come from where it was saved. */
  savedToken: SavedTokenId.optional(),
  kind: JiraKind.optional(), site: z.string().min(1).max(300).optional(), email: z.email().max(320).optional(), token: Token.optional(),
  /** Atlassian does not report a token's end date; the person who created it can record it for the reminder. */
  expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine(v => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Use a real date').optional(),
}).superRefine((v, c) => {
  if (v.savedToken) {
    if (v.kind || v.site || v.email || v.token || v.expiresOn) c.addIssue({ code: 'custom', message: 'A saved token brings its own Jira site and account; send nothing else with it' });
    return;
  }
  if (!v.kind) c.addIssue({ code: 'custom', path: ['kind'], message: 'Choose Jira Cloud or self-hosted Jira' });
  if (!v.site) c.addIssue({ code: 'custom', path: ['site'], message: 'Enter the Jira address' });
  if (v.kind === 'cloud' && !v.email) c.addIssue({ code: 'custom', path: ['email'], message: 'Jira Cloud needs the email of the account that owns the token' });
  if (v.kind === 'data-center' && v.email) c.addIssue({ code: 'custom', path: ['email'], message: 'A personal access token needs no email' });
});
export const JiraProjectKey = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,49}$/, 'Use a Jira project key such as WEB');
export const JiraRuleInput = z.strictObject({
  project: JiraProjectKey,
  /** Board column by name; resolved to its statuses when the rule is saved. */
  column: z.string().min(1).max(200).optional(),
  /** Jira user by id or exact display name. */
  assignee: z.string().min(1).max(200).optional(),
  label: z.string().min(1).max(255).regex(/^\S+$/, 'A Jira label has no spaces').optional(),
  start: z.enum(['manual', 'auto']).default('manual'),
}).refine(v => v.column || v.assignee || v.label, { message: 'Choose a column, an assignee or a label, so the rule cannot mean every ticket in the project' });

export type IntegrationProblem = { code: 'token_missing' | 'token_rejected' | 'not_reachable'; message: string; at: string };
export type GitHubIntegration = {
  /** Name the token is stored under. Projects on the same GitHub account share it. */
  savedToken: string; repository: string; login: string; tokenKind: 'fine-grained' | 'classic';
  /** `null` when GitHub does not report it for this token. */
  canPush: boolean | null; expiresAt?: string; connectedAt: string; checkedAt: string; problem?: IntegrationProblem;
};
export type JiraRule = {
  project: { key: string; name: string }; column?: { name: string; statusIds: string[] }; assignee?: { id: string; name: string };
  label?: string; start: 'manual' | 'auto'; jql: string; savedAt: string;
};
export type JiraIntegration = {
  /** Name the token is stored under. Projects on the same Jira account share it. */
  savedToken: string; kind: z.infer<typeof JiraKind>; site: string; email?: string; account: string;
  /** Cloud id when the token only works through Atlassian's gateway (a token created "with scopes"). */
  gateway?: string; expiresOn?: string; connectedAt: string; checkedAt: string; problem?: IntegrationProblem; rule?: JiraRule;
};
export type ProjectIntegrations = { github?: GitHubIntegration; jira?: JiraIntegration };

export type ConnectionState = 'connected' | 'expiring' | 'expired' | 'rejected' | 'unreachable' | 'locked';
/** Days before the end date from which a token is shown as expiring. */
export const EXPIRY_WARNING_DAYS = 14;
export function connectionState(connection: { expiresAt?: string; expiresOn?: string; problem?: IntegrationProblem }, now: Date, locked: boolean): { state: ConnectionState; expiresInDays?: number } {
  const end = connection.expiresAt ?? (connection.expiresOn ? `${connection.expiresOn}T23:59:59Z` : undefined);
  const expiresInDays = end ? Math.floor((Date.parse(end) - now.getTime()) / 86400000) : undefined;
  const days = expiresInDays === undefined ? {} : { expiresInDays };
  if (locked) return { state: 'locked', ...days };
  if (connection.problem) return { state: connection.problem.code === 'not_reachable' ? 'unreachable' : 'rejected', ...days };
  if (expiresInDays !== undefined && expiresInDays < 0) return { state: 'expired', ...days };
  if (expiresInDays !== undefined && expiresInDays <= EXPIRY_WARNING_DAYS) return { state: 'expiring', ...days };
  return { state: 'connected', ...days };
}
