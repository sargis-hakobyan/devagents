import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { AppError } from '../domain/errors.js';
import { NO_PULL_REQUESTS, PR_FAILED, PR_OPENED, PR_PUSHED, PR_SETTINGS, PullRequestSettings, type PublishFailure, type StepMode, type TaskPullRequest } from '../domain/pull-requests.js';
import type { Task } from '../domain/schemas.js';
import type { Store } from '../persistence/store.js';
import type { SecretStore } from '../security/secret-store.js';
import { firstLine, isTaskBranch } from '../workspace/branches.js';
import { GITHUB_API } from './github.js';
import { list, record, remote, text, type Fetch } from './http.js';

const exec = promisify(execFile);
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
};
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
  private readonly running = new Map<string, Promise<TaskPullRequest>>(); private sweeping = false;
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
