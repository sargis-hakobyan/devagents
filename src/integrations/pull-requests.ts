import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { AppError } from '../domain/errors.js';
import { NO_PULL_REQUESTS, PR_FAILED, PR_OPENED, PR_PUSHED, PR_SETTINGS, PullRequestSettings, pullRequestStatus, type CheckStatus, type PublishFailure, type PullRequestCheck, type PullRequestComment, type PullRequestSnapshot, type StepMode, type TaskPullRequest } from '../domain/pull-requests.js';
import type { Task } from '../domain/schemas.js';
import type { Store } from '../persistence/store.js';
import type { SecretStore } from '../security/secret-store.js';
import { firstLine, isTaskBranch } from '../workspace/branches.js';
import { GITHUB_API } from './github.js';
import { list, record, remote, text, type Fetch } from './http.js';

const exec = promisify(execFile);
const THREADS = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved path line comments(first:1){nodes{author{login} authorAssociation body url}}}}}}}';
export type PullRequestOptions = {
  fetch?: Fetch; githubApiUrl?: string; now?: () => Date;
  /** Where a repository is pushed to. Tests point this at a local bare repository. */
  remoteUrl?: (repository: string) => string;
};
export type ProjectPullRequests = { connected: boolean; repository?: string; settings: PullRequestSettings };
export type TaskPullRequestView = {
  /** The Publish choice the task started with. */
  mode: StepMode;
  /** A click can publish it now. */
  canPublish: boolean; publishing: boolean;
  pullRequest?: TaskPullRequest; failure?: PublishFailure;
  /** What GitHub last said about the pull request. */
  github?: PullRequestSnapshot;
};
const SYNC_EVERY_MS = 60000; const WRITERS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);
type Trigger = TaskPullRequest['trigger'];

/**
 * One Git command against GitHub. The token travels as an HTTP header set through the environment,
 * so it is never in an argument, a URL or a config file. Only the transport the remote uses is allowed,
 * no hook or credential helper runs, and Git's own output is not passed on.
 */
async function remoteGit(cwd: string, args: string[], url: string, token: string): Promise<string> {
  const web = /^https:\/\//.test(url);
  const auth = web ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${new URL(url).origin}/.extraheader`, GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` } : {};
  const { stdout } = await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-c', 'protocol.allow=never', '-c', `protocol.${web ? 'https' : 'file'}.allow=always`, '-c', `safe.directory=${cwd}`, ...args], {
    cwd, timeout: 120000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: homedir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true', ...auth },
  });
  return stdout.trim();
}

/**
 * Publishes a finished task: pushes its branch to the project's GitHub repository and opens a pull
 * request. Only the task's own `devagents/` branch is ever pushed, never with force, and never to
 * the branch the pull request targets. Before each step GitHub is asked what already exists, so a
 * repeated or interrupted publish neither pushes twice nor opens a second pull request.
 */
export class PullRequestService {
  private readonly fetcher: Fetch; private readonly api: string; private readonly now: () => Date; private readonly remoteUrl: (repository: string) => string;
  private readonly running = new Map<string, Promise<TaskPullRequest>>(); private sweeping = false; private syncing = false;
  constructor(private readonly store: Store, private readonly secrets: SecretStore, options: PullRequestOptions = {}) {
    this.fetcher = options.fetch ?? fetch; this.api = options.githubApiUrl ?? GITHUB_API; this.now = options.now ?? (() => new Date());
    this.remoteUrl = options.remoteUrl ?? (repository => `https://github.com/${repository}.git`);
  }

  project(projectId: string): ProjectPullRequests {
    const { github, pullRequests } = this.store.project(projectId).integrations ?? {};
    return { connected: Boolean(github), ...(github ? { repository: github.repository } : {}), settings: pullRequests ?? NO_PULL_REQUESTS };
  }
  save(projectId: string, input: unknown): ProjectPullRequests {
    const settings = PullRequestSettings.parse(input); const project = this.store.project(projectId);
    if (project.archivedAt) throw new AppError('project_archived', 'This project is archived. Restore it before changing it.', 409);
    if (settings.publish !== 'off' && !project.integrations?.github) throw new AppError('not_connected', 'Connect GitHub for this project before turning on pull requests.', 422);
    this.store.setProjectIntegrations(projectId, current => ({ ...current, pullRequests: settings }));
    return this.project(projectId);
  }
  /** Branch names of the connected repository, for choosing the target. */
  async branches(projectId: string): Promise<{ branches: string[]; defaultBranch: string }> {
    const { repository, token } = await this.access(projectId);
    const [repo, found] = await Promise.all([this.github(token, 'GET', `/repos/${repository}`), this.github(token, 'GET', `/repos/${repository}/branches?per_page=100`)]);
    if (repo.status !== 200 || found.status !== 200) throw new AppError('not_reachable', `GitHub did not list the branches of ${repository}. Check the connection on this page.`, 502);
    const defaultBranch = text(record(repo.json).default_branch, 200);
    const names = list(found.json).map(b => text(record(b).name, 200)).filter(name => name && !name.startsWith('devagents/'));
    return { branches: [...new Set([defaultBranch, ...names].filter(Boolean))], defaultBranch };
  }

  /** Called when a task is submitted: the task keeps the choices its project had at that moment. */
  freeze(taskId: string, projectId: string): void {
    const { connected, settings } = this.project(projectId);
    if (!connected || settings.publish === 'off' || this.store.lastEvidence(taskId, PR_SETTINGS)) return;
    this.store.record(taskId, PR_SETTINGS, settings);
  }
  private frozen(taskId: string): PullRequestSettings | undefined {
    const saved = this.store.lastEvidence(taskId, PR_SETTINGS);
    const parsed = saved && PullRequestSettings.safeParse(saved.data);
    return parsed && parsed.success ? parsed.data : undefined;
  }
  view(taskId: string): TaskPullRequestView {
    const task = this.store.task(taskId); const { connected, settings } = this.project(task.projectId);
    const frozen = this.frozen(taskId); const opened = this.store.lastEvidence(taskId, PR_OPENED); const failed = this.store.lastEvidence(taskId, PR_FAILED);
    // A click is the user's own decision, so it is offered whenever the project publishes at all, also for a task started before that was turned on.
    const offered = connected && ((frozen?.publish ?? 'off') !== 'off' || settings.publish !== 'off');
    return {
      mode: frozen?.publish ?? 'off', publishing: this.running.has(taskId),
      canPublish: offered && !opened && task.state === 'completed' && Boolean(task.outcome?.commit && task.workspace?.branch),
      ...(opened ? { pullRequest: opened.data as TaskPullRequest } : {}),
      ...(opened ? { github: this.snapshot(taskId, opened.data as TaskPullRequest) } : {}),
      ...(failed && (!opened || failed.sequence > opened.sequence) ? { failure: failed.data as PublishFailure } : {}),
    };
  }

  /** One publish per task at a time; a second request joins the first. */
  publish(taskId: string, trigger: Trigger): Promise<TaskPullRequest> {
    let running = this.running.get(taskId);
    if (!running) {
      running = this.run(taskId, trigger).catch(error => {
        const known = error instanceof AppError;
        // Only messages written here are kept: Git and GitHub output can quote addresses and account details.
        const message = known ? error.message : 'The pull request could not be opened. Nothing else was changed.';
        this.store.record(taskId, PR_FAILED, { message, at: this.now().toISOString(), trigger } satisfies PublishFailure);
        throw known ? error : new AppError('publish_failed', message, 502);
      }).finally(() => this.running.delete(taskId));
      this.running.set(taskId, running);
    }
    return running;
  }
  /** Publishes the finished tasks whose project asked for it. A task that failed to publish waits for a click and is not tried again here. */
  async publishDue(): Promise<void> {
    if (this.sweeping) return; this.sweeping = true;
    try {
      for (const id of this.store.completedAwaiting(PR_SETTINGS, [PR_OPENED, PR_FAILED])) {
        if (this.frozen(id)?.publish === 'auto') await this.publish(id, 'setting').catch(() => {});
      }
    } finally { this.sweeping = false; }
  }

  /** The stored state of a pull request; created the first time it is asked for. */
  private snapshot(taskId: string, opened: TaskPullRequest): PullRequestSnapshot {
    const saved = this.store.pullRequest(taskId);
    if (saved) return saved;
    const first = { number: opened.number, base: opened.base, state: 'open' as const, draft: opened.draft, headSha: opened.commit, mergeable: 'unknown' as const, checks: [], comments: [] };
    const snapshot = { ...first, status: pullRequestStatus(first) };
    this.store.savePullRequest(taskId, snapshot);
    return snapshot;
  }
  /** Reads the open pull requests that were last read more than a minute ago. */
  async syncDue(): Promise<void> {
    if (this.syncing) return; this.syncing = true;
    try {
      const due = this.store.openPullRequests().filter(id => { const s = this.store.pullRequest(id); return !s?.attemptedAt || this.now().getTime() - Date.parse(s.attemptedAt) >= SYNC_EVERY_MS; });
      for (const id of due.slice(0, 20)) await this.sync(id).catch(() => {});
    } finally { this.syncing = false; }
  }
  /** One read of a pull request: its state, the checks on its latest commit and its unresolved review comments. A failed read keeps what the last one found. */
  async sync(taskId: string): Promise<PullRequestSnapshot> {
    const opened = this.store.lastEvidence(taskId, PR_OPENED)?.data as TaskPullRequest | undefined;
    if (!opened) throw new AppError('not_published', 'This task has no pull request.', 404);
    const previous = this.snapshot(taskId, opened); const at = this.now().toISOString();
    try {
      const { token } = await this.access(this.store.task(taskId).projectId); const repo = `/repos/${opened.repository}`;
      const pull = await this.github(token, 'GET', `${repo}/pulls/${opened.number}`);
      if (pull.status !== 200) throw this.refused(pull.status, `read pull request #${opened.number}`);
      const pr = record(pull.json); const headSha = text(record(pr.head).sha, 64) || previous.headSha;
      const state = pr.merged === true ? 'merged' as const : pr.state === 'closed' ? 'closed' as const : 'open' as const;
      const verdict = text(pr.mergeable_state, 40);
      const mergeable = pr.mergeable === false || verdict === 'dirty' ? 'conflict' as const : verdict === 'blocked' ? 'blocked' as const : verdict ? 'clean' as const : 'unknown' as const;
      let checks = previous.checks; let comments = previous.comments;
      if (state === 'open') {
        const [runs, statuses, threads] = await Promise.all([
          this.github(token, 'GET', `${repo}/commits/${headSha}/check-runs?per_page=100`), this.github(token, 'GET', `${repo}/commits/${headSha}/status?per_page=100`),
          this.github(token, 'POST', '/graphql', { query: THREADS, variables: { owner: opened.repository.split('/')[0], name: opened.repository.split('/')[1], number: opened.number } }),
        ]);
        if (runs.status !== 200) throw this.refused(runs.status, 'read the checks of the pull request');
        if (statuses.status !== 200) throw this.refused(statuses.status, 'read the checks of the pull request');
        if (threads.status !== 200 || record(threads.json).errors) throw this.refused(threads.status === 200 ? 403 : threads.status, 'read the review comments of the pull request');
        checks = this.checks(record(runs.json).check_runs, record(statuses.json).statuses);
        comments = this.comments(record(record(record(record(record(threads.json).data).repository).pullRequest).reviewThreads).nodes);
      }
      const read = { number: opened.number, base: text(record(pr.base).ref, 200) || previous.base, state, draft: pr.draft === true, headSha, mergeable, checks, comments, syncedAt: at, attemptedAt: at };
      const snapshot = { ...read, status: pullRequestStatus(read) };
      this.store.savePullRequest(taskId, snapshot);
      return snapshot;
    } catch (error) {
      const { error: _, ...kept } = previous;
      const snapshot = { ...kept, attemptedAt: at, error: error instanceof AppError ? error.message : 'GitHub could not be read.' };
      this.store.savePullRequest(taskId, snapshot);
      return snapshot;
    }
  }
  private checks(runs: unknown, statuses: unknown): PullRequestCheck[] {
    const found = new Map<string, PullRequestCheck>();
    const add = (name: string, status: CheckStatus, url: string, summary: string) => { if (name && !found.has(name)) found.set(name, { name, status, ...(/^https:\/\//.test(url) ? { url } : {}), ...(summary ? { summary } : {}) }); };
    for (const value of list(runs)) {
      const run = record(value); const conclusion = text(run.conclusion, 40);
      const status = run.status !== 'completed' ? 'running' : conclusion === 'success' ? 'passed' : FAILED.has(conclusion) ? 'failed' : 'skipped';
      add(text(run.name, 200), status, text(run.html_url, 500), text(record(run.output).title, 300));
    }
    for (const value of list(statuses)) {
      const entry = record(value); const state = text(entry.state, 40);
      add(text(entry.context, 200), state === 'success' ? 'passed' : state === 'pending' ? 'running' : 'failed', text(entry.target_url, 500), text(entry.description, 300));
    }
    return [...found.values()].slice(0, 100);
  }
  /** Unresolved review threads, each shown by its first comment. */
  private comments(threads: unknown): PullRequestComment[] {
    const open: PullRequestComment[] = [];
    for (const value of list(threads)) {
      const thread = record(value); const first = record(list(record(thread.comments).nodes)[0]); const id = text(thread.id, 200);
      if (thread.isResolved === true || !id) continue;
      const path = text(thread.path, 500); const line = Number(thread.line); const url = text(first.url, 500);
      open.push({ id, author: text(record(first.author).login, 100) || 'unknown', counts: WRITERS.has(text(first.authorAssociation, 40)), body: text(first.body, 2000), ...(path ? { path } : {}), ...(Number.isInteger(line) && line > 0 ? { line } : {}), ...(/^https:\/\//.test(url) ? { url } : {}) });
    }
    return open;
  }

  private async access(projectId: string): Promise<{ repository: string; token: string; canPush: boolean | null }> {
    const github = this.store.project(projectId).integrations?.github;
    if (!github) throw new AppError('not_connected', 'GitHub is not connected for this project.', 422);
    const token = await this.secrets.get(github.savedToken);
    if (!token) throw new AppError('token_required', 'The GitHub token of this project is missing. Connect GitHub again on the project page.', 422);
    return { repository: github.repository, token, canPush: github.canPush };
  }
  private github(token: string, method: string, path: string, body?: unknown) {
    return remote(this.fetcher, 'GitHub', `${this.api}${path}`, { method, headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'devagents' }, ...(body === undefined ? {} : { body }) });
  }
  private refused(status: number, what: string): AppError {
    if (status === 401) return new AppError('token_rejected', 'GitHub did not accept the token of this project. Replace it on the project page.', 422);
    if (status === 403 || status === 404) return new AppError('not_permitted', `The GitHub token of this project may not ${what}. Give it read and write access to contents and pull requests.`, 422);
    return new AppError('publish_failed', `GitHub refused to ${what} (${status}).`, 502);
  }

  private async run(taskId: string, trigger: Trigger): Promise<TaskPullRequest> {
    const task = this.store.task(taskId);
    const already = this.store.lastEvidence(taskId, PR_OPENED);
    if (already) return already.data as TaskPullRequest;
    if (trigger === 'user' && !this.view(taskId).canPublish) throw new AppError('not_publishable', 'Only a completed task of a project that publishes pull requests can be published.', 409);
    const commit = task.outcome?.commit; const branch = task.workspace?.branch;
    if (task.state !== 'completed' || !commit || !branch) throw new AppError('not_publishable', 'Only a completed task with a commit can be published.', 409);
    if (!isTaskBranch(branch, task.id)) throw new AppError('not_publishable', 'This task\'s branch is not one DevAgents created, so it is not pushed.', 409);
    const project = this.store.project(task.projectId);
    const { repository, token, canPush } = await this.access(task.projectId);
    if (canPush === false) throw new AppError('not_permitted', `The GitHub token of this project cannot push to ${repository}.`, 422);
    const settings = this.frozen(taskId) ?? this.project(task.projectId).settings;
    let base = settings.targetBranch;
    if (!base) {
      const repo = await this.github(token, 'GET', `/repos/${repository}`);
      if (repo.status !== 200) throw this.refused(repo.status, `read ${repository}`);
      base = text(record(repo.json).default_branch, 200);
      if (!base) throw new AppError('publish_failed', `GitHub did not name the default branch of ${repository}.`, 502);
    }
    if (base === branch) throw new AppError('not_publishable', 'A task branch cannot be merged into itself.', 409);

    await this.push(project.path, repository, token, branch, commit, taskId);
    const pullRequest = await this.open(task, repository, token, branch, base, commit, trigger);
    this.store.record(taskId, PR_OPENED, pullRequest);
    this.snapshot(taskId, pullRequest);
    return pullRequest;
  }
  private async push(cwd: string, repository: string, token: string, branch: string, commit: string, taskId: string): Promise<void> {
    const url = this.remoteUrl(repository); const ref = `refs/heads/${branch}`;
    let remoteCommit: string;
    try { remoteCommit = (await remoteGit(cwd, ['ls-remote', url, ref], url, token)).split(/\s/)[0] ?? ''; }
    catch { throw new AppError('push_failed', `GitHub could not be reached to push to ${repository}, or the token may not read it.`, 502); }
    if (remoteCommit === commit) return;
    if (remoteCommit) throw new AppError('branch_taken', `${repository} already has a branch named ${branch} with other commits. It was not changed.`, 409);
    try { await remoteGit(cwd, ['push', '--no-verify', url, `${commit}:${ref}`], url, token); }
    catch { throw new AppError('push_failed', `GitHub did not accept the push of ${branch} to ${repository}. The token needs write access to contents.`, 502); }
    this.store.record(taskId, PR_PUSHED, { repository, branch, commit, at: this.now().toISOString() });
  }
  private async open(task: Task, repository: string, token: string, branch: string, base: string, commit: string, trigger: Trigger): Promise<TaskPullRequest> {
    const owner = repository.split('/')[0]!;
    const found = (value: unknown, draft?: boolean): TaskPullRequest | undefined => {
      const pr = record(value); const number = Number(pr.number); const url = text(pr.html_url, 500);
      if (!Number.isInteger(number) || number < 1 || !/^https:\/\//.test(url)) return;
      return { number, url, repository, branch, base: text(record(pr.base).ref, 200) || base, commit, draft: draft ?? pr.draft === true, openedAt: this.now().toISOString(), trigger };
    };
    const existing = await this.github(token, 'GET', `/repos/${repository}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=all&per_page=1`);
    if (existing.status !== 200) throw this.refused(existing.status, `read the pull requests of ${repository}`);
    const first = found(list(existing.json)[0]);
    if (first) return first;
    const title = firstLine(task.request).slice(0, 200) || `DevAgents task ${task.id.slice(0, 8)}`;
    const body = [task.outcome?.summary?.trim(), `Opened by DevAgents from task ${task.id}.`].filter(Boolean).join('\n\n').slice(0, 60000);
    // Drafts are not available on every plan; the pull request is then opened as ready.
    for (const draft of [true, false]) {
      const created = await this.github(token, 'POST', `/repos/${repository}/pulls`, { title, head: branch, base, body, draft });
      const opened = created.status === 201 ? found(created.json, draft) : undefined;
      if (opened) return opened;
      if (created.status !== 422 || !draft) {
        if (created.status === 422) throw new AppError('publish_failed', `GitHub did not open a pull request from ${branch} into ${base}. Check that ${base} exists and differs from the task's branch.`, 422);
        throw this.refused(created.status, `open a pull request in ${repository}`);
      }
    }
    throw new AppError('publish_failed', 'GitHub did not open the pull request.', 502);
  }
}
