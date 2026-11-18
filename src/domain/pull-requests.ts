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
