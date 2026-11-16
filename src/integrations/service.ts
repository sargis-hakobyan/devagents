import { createHash } from 'node:crypto';
import { AppError } from '../domain/errors.js';
import { GitHubConnectInput, JiraConnectInput, JiraProjectKey, JiraRuleInput, connectionState, type ConnectionState, type GitHubIntegration, type IntegrationProblem, type JiraIntegration, type JiraRule } from '../domain/integrations.js';
import type { Store } from '../persistence/store.js';
import type { SecretStore } from '../security/secret-store.js';
import { GITHUB_API, folderRepository, tokenKind, verifyGitHub } from './github.js';
import type { Fetch } from './http.js';
import { jiraAssignee, jiraColumns, jiraMatches, jiraOptions, jiraProject, jiraProjects, jiraSuggest, normalizeSite, ruleJql, verifyJira, type JiraAccess, type JiraMatches, type JiraOptions, type JiraSuggestion } from './jira.js';

type Kind = 'github' | 'jira';
type Shown<T> = T & { state: ConnectionState; expiresInDays?: number };
/** A token that is saved once and can serve several projects on the same account. */
export type SavedToken = { id: string; label: string; usedBy: { id: string; name: string }[] };
export type IntegrationsView = {
  projectId: string;
  folder: { path: string; hostPath?: string; repository: string | null };
  /** The variables are only named where tokens come from the environment. */
  secrets: { mode: SecretStore['mode']; locked: boolean; githubVariable?: string; jiraVariable?: string };
  /** Every saved token with the projects that use it, so another project can reuse one without pasting it again. */
  savedTokens: { github: SavedToken[]; jira: SavedToken[] };
  github: Shown<GitHubIntegration> | null;
  jira: Shown<JiraIntegration> | null;
};
export type IntegrationServiceOptions = { fetch?: Fetch; githubApiUrl?: string; now?: () => Date };

const sameText = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
const tokenProblem = (problem: IntegrationProblem | undefined) => problem?.code === 'token_rejected' || problem?.code === 'token_missing';

/**
 * Connects a project to GitHub and Jira: verifies a token, keeps it in the secret store, and saves
 * what was found. A token is stored once per account and shared by the projects on that account, so
 * it is pasted and replaced in one place. It stores and checks configuration only; nothing here
 * pushes, opens pull requests or creates tasks.
 */
export class ProjectIntegrationService {
  private readonly fetcher: Fetch; private readonly githubApi: string; private readonly now: () => Date;
  constructor(private readonly store: Store, private readonly secrets: SecretStore, options: IntegrationServiceOptions = {}) {
    this.fetcher = options.fetch ?? fetch; this.githubApi = options.githubApiUrl ?? GITHUB_API; this.now = options.now ?? (() => new Date());
  }
  private get shared() { return this.secrets.mode === 'vault'; }
  private active(projectId: string) {
    const project = this.store.project(projectId);
    if (project.archivedAt) throw new AppError('project_archived', 'This project is archived. Restore it before connecting it.', 409);
    return project;
  }
  private stamp() { return this.now().toISOString(); }
  /**
   * The name a token is stored under. In the vault it is derived from the account, which is what makes
   * projects share it. Environment tokens are one variable per project, so the name is the project's.
   */
  private tokenName(kind: Kind, projectId: string, account: string): string {
    if (!this.shared) return `${kind}-${projectId}`;
    return kind === 'github' ? `github-${account.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 100)}` : `jira-${createHash('sha256').update(account.toLowerCase()).digest('hex').slice(0, 20)}`;
  }
  private savedTokens(kind: Kind): SavedToken[] {
    if (!this.shared) return [];
    const found = new Map<string, SavedToken>();
    for (const project of this.store.projects()) {
      const connection = project.integrations?.[kind]; if (!connection) continue;
      const label = kind === 'github' ? `@${(connection as GitHubIntegration).login}` : `${(connection as JiraIntegration).account} · ${(connection as JiraIntegration).site.replace(/^https:\/\//, '')}`;
      const entry = found.get(connection.savedToken) ?? { id: connection.savedToken, label, usedBy: [] };
      entry.usedBy.push({ id: project.id, name: project.name ?? project.id }); found.set(connection.savedToken, entry);
    }
    return [...found.values()];
  }
  /** A saved-token id is only honoured when a project already uses it, so it cannot name an arbitrary secret. */
  private async reuse(kind: Kind, id: string): Promise<{ token: string; from: string }> {
    const saved = this.savedTokens(kind).find(t => t.id === id);
    const token = saved && await this.secrets.get(id);
    if (!saved || !token) throw new AppError('unknown_saved_token', 'No saved token with this id. Look at the integrations view for the ones that exist.', 422);
    return { token, from: saved.usedBy[0]!.id };
  }
  private required(name: string): AppError {
    return new AppError('token_required', this.shared ? 'Paste a token to connect.' : `Set ${this.secrets.variable(name)} and restart the service, then connect again.`, 422);
  }
  private problem(error: unknown): IntegrationProblem | undefined {
    if (!(error instanceof AppError)) return;
    if (error.code === 'token_rejected' || error.code === 'not_reachable' || error.code === 'token_required') return { code: error.code === 'token_required' ? 'token_missing' : error.code, message: error.message, at: this.stamp() };
    return;
  }
  /** Applies what was learned about a shared token to every other project that uses it. */
  private spread<T extends GitHubIntegration | JiraIntegration>(kind: Kind, savedToken: string, except: string, change: (connection: T) => T): void {
    if (!this.shared) return;
    for (const project of this.store.projects()) {
      if (project.id === except || project.integrations?.[kind]?.savedToken !== savedToken) continue;
      this.store.setProjectIntegrations(project.id, current => current[kind] ? { ...current, [kind]: change(current[kind] as T) } : current);
    }
  }
  /** Forgets a token once no project uses it any more. */
  private async release(kind: Kind, savedToken: string | undefined): Promise<void> {
    if (!savedToken || this.store.projects().some(p => p.integrations?.[kind]?.savedToken === savedToken)) return;
    await this.secrets.remove(savedToken);
  }

  async view(projectId: string): Promise<IntegrationsView> {
    const project = this.store.project(projectId);
    const locked = await this.secrets.locked(); const now = this.now();
    const { github, jira } = project.integrations ?? {};
    return {
      projectId, folder: { path: project.path, ...(project.hostPath ? { hostPath: project.hostPath } : {}), repository: await folderRepository(project.path) ?? null },
      secrets: { mode: this.secrets.mode, locked, ...(this.shared ? {} : { githubVariable: this.secrets.variable(`github-${projectId}`), jiraVariable: this.secrets.variable(`jira-${projectId}`) }) },
      savedTokens: { github: this.savedTokens('github'), jira: this.savedTokens('jira') },
      github: github ? { ...github, ...connectionState(github, now, locked) } : null,
      jira: jira ? { ...jira, ...connectionState(jira, now, locked) } : null,
    };
  }

  /** A pasted token, a token saved for another project, or (with neither) this project's current token checked again. */
  async connectGitHub(projectId: string, input: unknown): Promise<IntegrationsView> {
    const parsed = GitHubConnectInput.parse(input); const project = this.active(projectId); const previous = project.integrations?.github;
    if (parsed.token && !this.shared) await this.secrets.set(`github-${projectId}`, parsed.token);
    const current = this.shared ? previous?.savedToken : `github-${projectId}`;
    const token = parsed.savedToken ? (await this.reuse('github', parsed.savedToken)).token : parsed.token ?? (current ? await this.secrets.get(current) : undefined);
    if (!token) throw this.required(`github-${projectId}`);
    const kind = tokenKind(token);
    if (!kind) throw new AppError('invalid_token', 'A GitHub token starts with github_pat_ (fine-grained) or ghp_ (classic).', 422);
    const repository = parsed.repository ?? previous?.repository ?? await folderRepository(project.path);
    if (!repository) throw new AppError('repository_unknown', 'This folder has no GitHub remote named origin. Enter the repository as owner/name.', 422);
    const check = await verifyGitHub(this.fetcher, this.githubApi, token, repository);
    const savedToken = parsed.savedToken ?? (parsed.token ? this.tokenName('github', projectId, check.login) : current!);
    if (parsed.token) await this.secrets.set(savedToken, parsed.token);
    const at = this.stamp();
    this.store.setProjectIntegrations(projectId, all => ({ ...all, github: { savedToken, repository, tokenKind: kind, ...check, connectedAt: previous?.repository === repository ? previous.connectedAt : at, checkedAt: at } }));
    // A replaced token is replaced for every project on the account: they get its facts and lose a token problem.
    if (parsed.token) this.spread<GitHubIntegration>('github', savedToken, projectId, other => {
      const { expiresAt: _, problem, ...rest } = other;
      return { ...rest, tokenKind: kind, ...(check.expiresAt ? { expiresAt: check.expiresAt } : {}), ...(problem && !tokenProblem(problem) ? { problem } : {}) };
    });
    if (previous && previous.savedToken !== savedToken) await this.release('github', previous.savedToken);
    return this.view(projectId);
  }
  async checkGitHub(projectId: string): Promise<IntegrationsView> {
    const saved = this.store.project(projectId).integrations?.github;
    if (!saved) throw new AppError('not_connected', 'GitHub is not connected for this project', 404);
    let update: GitHubIntegration;
    try {
      const token = await this.secrets.get(saved.savedToken);
      if (!token) throw this.required(saved.savedToken);
      const { problem: _, expiresAt: __, ...rest } = saved;
      update = { ...rest, ...await verifyGitHub(this.fetcher, this.githubApi, token, saved.repository), checkedAt: this.stamp() };
    } catch (error) {
      const problem = this.problem(error); if (!problem) throw error;
      update = { ...saved, problem, checkedAt: problem.at };
    }
    this.store.setProjectIntegrations(projectId, current => current.github ? { ...current, github: update } : current);
    // A refused token is refused for everyone who shares it, and an accepted one clears that everywhere.
    const refused = tokenProblem(update.problem) ? update.problem : undefined;
    if (refused || update.problem?.code !== 'not_reachable') this.spread<GitHubIntegration>('github', saved.savedToken, projectId, other => {
      const { problem, ...rest } = other;
      return refused ? { ...rest, problem: refused } : { ...rest, ...(problem && !tokenProblem(problem) ? { problem } : {}) };
    });
    return this.view(projectId);
  }

  private async jiraAccess(projectId: string): Promise<{ saved: JiraIntegration; access: JiraAccess }> {
    const saved = this.store.project(projectId).integrations?.jira;
    if (!saved) throw new AppError('not_connected', 'Jira is not connected for this project', 404);
    const token = await this.secrets.get(saved.savedToken);
    if (!token) throw this.required(saved.savedToken);
    return { saved, access: { kind: saved.kind, site: saved.site, token, ...(saved.email ? { email: saved.email } : {}), ...(saved.gateway ? { gateway: saved.gateway } : {}) } };
  }
  async connectJira(projectId: string, input: unknown): Promise<IntegrationsView> {
    const parsed = JiraConnectInput.parse(input); const project = this.active(projectId); const previous = project.integrations?.jira;
    // A saved token brings the Jira it belongs to: site, kind, email and the recorded end date.
    const reused = parsed.savedToken ? await this.reuse('jira', parsed.savedToken) : undefined;
    const source = reused ? this.store.project(reused.from).integrations!.jira! : undefined;
    const kind = source?.kind ?? parsed.kind!; const site = source?.site ?? normalizeSite(parsed.site!); const email = source ? source.email : parsed.email;
    const same = previous?.site === site && previous.kind === kind && previous.email === email;
    if (parsed.token && !this.shared) await this.secrets.set(`jira-${projectId}`, parsed.token);
    const current = this.shared ? (same ? previous!.savedToken : undefined) : `jira-${projectId}`;
    const token = reused?.token ?? parsed.token ?? (current ? await this.secrets.get(current) : undefined);
    if (!token) throw this.required(`jira-${projectId}`);
    const check = await verifyJira(this.fetcher, { kind, site, token, ...(email ? { email } : {}) });
    const savedToken = parsed.savedToken ?? (parsed.token ? this.tokenName('jira', projectId, `${kind}\n${site}\n${email ?? check.account}`) : current!);
    if (parsed.token) await this.secrets.set(savedToken, parsed.token);
    const at = this.stamp();
    // A new token has a new end date; a reused or rechecked one keeps the date recorded for it.
    const expiresOn = parsed.token ? parsed.expiresOn : parsed.expiresOn ?? source?.expiresOn ?? (same ? previous!.expiresOn : undefined);
    // A pick-up rule names things of one Jira; it does not carry over to another site.
    const sameSite = previous?.site === site && previous.kind === kind;
    const jira: JiraIntegration = {
      savedToken, kind, site, account: check.account, connectedAt: sameSite ? previous.connectedAt : at, checkedAt: at,
      ...(email ? { email } : {}), ...(check.gateway ? { gateway: check.gateway } : {}), ...(expiresOn ? { expiresOn } : {}),
      ...(sameSite && previous.rule ? { rule: previous.rule } : {}),
    };
    this.store.setProjectIntegrations(projectId, all => ({ ...all, jira }));
    if (parsed.token) this.spread<JiraIntegration>('jira', savedToken, projectId, other => {
      const { expiresOn: _, gateway: __, problem, ...rest } = other;
      return { ...rest, account: check.account, ...(check.gateway ? { gateway: check.gateway } : {}), ...(expiresOn ? { expiresOn } : {}), ...(problem && !tokenProblem(problem) ? { problem } : {}) };
    });
    if (previous && previous.savedToken !== savedToken) await this.release('jira', previous.savedToken);
    return this.view(projectId);
  }
  async checkJira(projectId: string): Promise<IntegrationsView> {
    const saved = this.store.project(projectId).integrations?.jira;
    if (!saved) throw new AppError('not_connected', 'Jira is not connected for this project', 404);
    let update: JiraIntegration;
    try {
      const { access } = await this.jiraAccess(projectId);
      const { gateway: _, ...direct } = access;
      const check = await verifyJira(this.fetcher, direct);
      const { problem: __, gateway: ___, ...rest } = saved;
      update = { ...rest, account: check.account, ...(check.gateway ? { gateway: check.gateway } : {}), checkedAt: this.stamp() };
    } catch (error) {
      const problem = this.problem(error); if (!problem) throw error;
      update = { ...saved, problem, checkedAt: problem.at };
    }
    this.store.setProjectIntegrations(projectId, current => current.jira ? { ...current, jira: update } : current);
    const refused = tokenProblem(update.problem) ? update.problem : undefined;
    if (refused || update.problem?.code !== 'not_reachable') this.spread<JiraIntegration>('jira', saved.savedToken, projectId, other => {
      const { problem, ...rest } = other;
      return refused ? { ...rest, problem: refused } : { ...rest, ...(problem && !tokenProblem(problem) ? { problem } : {}) };
    });
    return this.view(projectId);
  }
  /** Jira projects, and for one project the columns, people and labels a rule can name. */
  async jiraChoices(projectId: string, projectKey?: string): Promise<{ projects: { key: string; name: string }[]; options?: JiraOptions }> {
    const { access } = await this.jiraAccess(projectId);
    const key = projectKey === undefined ? undefined : JiraProjectKey.parse(projectKey);
    const [projects, options] = await Promise.all([jiraProjects(this.fetcher, access), key ? jiraOptions(this.fetcher, access, key) : undefined]);
    return { projects, ...(options ? { options } : {}) };
  }
  /** Only the columns of one Jira project, for the rule editor, which looks up projects, people and labels as you type. */
  async jiraColumnChoices(projectId: string, projectKey: string): Promise<{ options: Pick<JiraOptions, 'columns' | 'columnsFrom'> }> {
    const { access } = await this.jiraAccess(projectId);
    return { options: await jiraColumns(this.fetcher, access, JiraProjectKey.parse(projectKey)) };
  }
  /** Type-ahead: Jira projects, the assignable people of one project, or labels, matching what was typed. */
  async jiraSuggestions(projectId: string, kind: unknown, query: string, projectKey?: string): Promise<{ items: JiraSuggestion[] }> {
    const { access } = await this.jiraAccess(projectId);
    if (kind !== 'projects' && kind !== 'people' && kind !== 'labels') throw new AppError('invalid_request', 'Search for projects, people or labels');
    return { items: await jiraSuggest(this.fetcher, access, kind, query, projectKey === undefined ? undefined : JiraProjectKey.parse(projectKey)) };
  }
  private async resolveRule(projectId: string, input: unknown): Promise<{ rule: JiraRule; access: JiraAccess }> {
    const parsed = JiraRuleInput.parse(input); const { access } = await this.jiraAccess(projectId);
    // Each part is looked up on its own, so a rule works in a Jira with more projects and people than a list can hold.
    const project = await jiraProject(this.fetcher, access, parsed.project.toUpperCase()) ?? await jiraProject(this.fetcher, access, parsed.project);
    if (!project) throw new AppError('invalid_rule', `This account cannot see a Jira project with the key ${parsed.project}.`, 422);
    let column: JiraOptions['columns'][number] | undefined;
    if (parsed.column !== undefined) {
      const { columns } = await jiraColumns(this.fetcher, access, project.key);
      column = columns.find(c => sameText(c.name, parsed.column!));
      if (!column) throw new AppError('invalid_rule', `Project ${project.key} has no column named "${parsed.column}". Available: ${columns.map(c => c.name).join(', ') || 'none'}.`, 422);
    }
    let assignee: JiraSuggestion | undefined;
    if (parsed.assignee !== undefined) {
      const found = await jiraAssignee(this.fetcher, access, project.key, parsed.assignee);
      if (!found.user) throw new AppError('invalid_rule', found.sameName > 1 ? `Several people in ${project.key} are named "${parsed.assignee}". Use the user id instead.` : `Nobody named "${parsed.assignee}" can be assigned tickets in ${project.key}.`, 422);
      assignee = found.user;
    }
    const chosen = { project, ...(column ? { column } : {}), ...(assignee ? { assignee } : {}), ...(parsed.label ? { label: parsed.label } : {}) };
    return { rule: { ...chosen, start: parsed.start, jql: ruleJql(chosen), savedAt: this.stamp() }, access };
  }
  /** What a rule would match right now, without saving it. */
  async previewJiraRule(projectId: string, input: unknown): Promise<{ rule: JiraRule; matches: JiraMatches }> {
    const { rule, access } = await this.resolveRule(projectId, input);
    return { rule, matches: await jiraMatches(this.fetcher, access, rule.jql) };
  }
  /** Saves a rule only after Jira accepted its search, so a saved rule is one that runs. */
  async saveJiraRule(projectId: string, input: unknown): Promise<{ integrations: IntegrationsView; matches: JiraMatches }> {
    const { rule, matches } = await this.previewJiraRule(projectId, input);
    this.store.setProjectIntegrations(projectId, current => {
      if (!current.jira) throw new AppError('not_connected', 'Jira is not connected for this project', 404);
      return { ...current, jira: { ...current.jira, rule } };
    });
    return { integrations: await this.view(projectId), matches };
  }
  /** Removes this project's connection. The token itself stays while another project still uses it. */
  async disconnect(projectId: string, kind: Kind): Promise<IntegrationsView> {
    const savedToken = this.store.project(projectId).integrations?.[kind]?.savedToken;
    this.store.setProjectIntegrations(projectId, current => { const { [kind]: _, ...rest } = current; return rest; });
    await this.release(kind, savedToken);
    return this.view(projectId);
  }
}
