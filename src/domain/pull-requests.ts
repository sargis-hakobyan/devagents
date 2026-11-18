import { z } from 'zod';

/**
 * What DevAgents does with a finished task on GitHub. Each step is skipped, waits for a click, or
 * runs on its own. Only publishing exists so far; fixing and merging add their own steps here.
 */
export const StepMode = z.enum(['off', 'ask', 'auto']);
export type StepMode = z.infer<typeof StepMode>;
export const BranchName = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, 'Use a branch name such as main').refine(v => !v.includes('..') && !v.endsWith('/') && !v.endsWith('.lock'), 'Use a branch name such as main');
export const PullRequestSettings = z.strictObject({
  publish: StepMode.default('off'),
  /** The branch pull requests open into. Without it, the repository's default branch. */
  targetBranch: BranchName.optional(),
});
export type PullRequestSettings = z.infer<typeof PullRequestSettings>;
export const NO_PULL_REQUESTS: PullRequestSettings = { publish: 'off' };

/** The pull request a task was published as. */
export type TaskPullRequest = { number: number; url: string; repository: string; branch: string; base: string; commit: string; draft: boolean; openedAt: string; trigger: 'user' | 'setting' };
export type PublishFailure = { message: string; at: string; trigger: 'user' | 'setting' };
/** Evidence kinds: the settings a task started with, the push, the opened pull request, and a publish that failed. */
export const PR_SETTINGS = 'pull-request-settings'; export const PR_PUSHED = 'pull-request-pushed'; export const PR_OPENED = 'pull-request-opened'; export const PR_FAILED = 'pull-request-failed';

/** What GitHub last said about a task's pull request. Read by the service about once a minute while the pull request is open. */
export type CheckStatus = 'passed' | 'failed' | 'running' | 'skipped';
export type PullRequestCheck = { name: string; status: CheckStatus; url?: string; /** GitHub's own short description of the result. Remote text, shown as plain text. */ summary?: string };
export type PullRequestComment = {
  id: string; author: string;
  /** The author can write to the repository. Other comments are shown and never block or start anything. */
  counts: boolean; path?: string; line?: number; body: string; url?: string;
};
export type PullRequestState = 'open' | 'merged' | 'closed';
export type PullRequestStatus = { code: 'not-read' | 'merged' | 'closed' | 'checks-failed' | 'checks-running' | 'conflict' | 'comments-open' | 'waiting' | 'ready'; text: string };
export type PullRequestSnapshot = {
  number: number; base: string; state: PullRequestState; draft: boolean; headSha: string;
  /** GitHub's verdict on merging: `blocked` covers branch protection such as a required approval. */
  mergeable: 'clean' | 'conflict' | 'blocked' | 'unknown';
  checks: PullRequestCheck[]; comments: PullRequestComment[];
  /** Empty until GitHub has been read once. */
  syncedAt?: string; attemptedAt?: string;
  /** Why the last read failed; the rest is what the read before it found. */
  error?: string;
  status: PullRequestStatus;
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** One line for the task page and the board: the first thing that stands between this pull request and a merge. */
export function pullRequestStatus(s: Omit<PullRequestSnapshot, 'status'>): PullRequestStatus {
  if (s.state === 'merged') return { code: 'merged', text: `merged into ${s.base}` };
  if (s.state === 'closed') return { code: 'closed', text: 'closed without merging' };
  if (!s.syncedAt) return { code: 'not-read', text: 'opened' };
  const failed = s.checks.filter(c => c.status === 'failed').length; const running = s.checks.filter(c => c.status === 'running').length;
  const open = s.comments.filter(c => c.counts).length;
  if (failed) return { code: 'checks-failed', text: `${plural(failed, 'check')} failed` };
  if (running) return { code: 'checks-running', text: 'checks running' };
  if (s.mergeable === 'conflict') return { code: 'conflict', text: `conflict with ${s.base}` };
  if (open) return { code: 'comments-open', text: `${plural(open, 'comment')} open` };
  if (s.mergeable === 'blocked') return { code: 'waiting', text: 'waiting for GitHub' };
  return { code: 'ready', text: 'ready to merge' };
}
