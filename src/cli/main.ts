#!/usr/bin/env node
import { SetupAuth, codexSetupDriver, claudeSetupDriver, assertSignInIdle, type AuthJob } from '../setup/auth.js';
import { readHiddenKey } from './secret-prompt.js';
import { Command, Option } from 'commander';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { ModelCatalogService, claudeModelLister, codexModelLister } from '../engines/model-catalog.js';
import { loadConfig, dataDirectory } from '../config.js';
import { Store } from '../persistence/store.js';
import { TaskService } from '../orchestration/service.js';
import { createApi, accessToken } from '../api/server.js';
import { BrowserSessions, sessionFile, sessionLimits } from '../api/session.js';
import { findUiRoot } from '../api/static.js';
import { statusReporter } from '../api/status.js';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineHealth } from '../engines/health.js';
import { environmentSecrets, log, redactValues } from '../telemetry/redact.js';
import { AppError } from '../domain/errors.js';
import { EngineRegistry } from '../engines/registry.js';
import { ClaudeAdapter } from '../engines/claude/adapter.js';
import { CodexAdapter } from '../engines/codex/adapter.js';
import { CodexValidator } from '../engines/codex/validator.js';
import { TaskRunner } from '../orchestration/runner.js';
import { DiskReserve } from '../workspace/disk-reserve.js';
import { lockService } from '../persistence/service-lock.js';
import { codexAuthStatus } from '../engines/codex/setup.js';
import { testCodexConnection } from '../engines/codex/connection-test.js';
import { onboard } from './onboarding.js';
import type { AuthChoice } from '../domain/auth.js';
import { selectChoice } from './choice-prompt.js';
import { configuredVault } from '../security/credential-vault.js';
import { configuredSecretStore } from '../security/secret-store.js';
import { hostFolders } from './project-mount.js';
import { ProjectIntegrationService } from '../integrations/service.js';
import { TrackerService } from '../integrations/trackers.js';
import { downloadTicketFiles } from '../integrations/ticket-files.js';

const print = (data: unknown) => console.log(JSON.stringify(redactValues(data, environmentSecrets()), null, 2));
const port = () => z.coerce.number().int().min(1).max(65535).parse(process.env.DEVAGENTS_PORT ?? 4310);
async function request(path: string, method = 'GET', body?: unknown, key?: string): Promise<unknown> {
  const token = (await readFile(join(dataDirectory(), 'api-token'), 'utf8')).trim();
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  if (key) headers['idempotency-key'] = key;
  const res = await fetch(`http://127.0.0.1:${port()}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
  const result = await res.json();
  if (!res.ok) throw new AppError('api_error', JSON.stringify(result), res.status);
  return result;
}
const cli = new Command().name('devagents').description('Local-first configurable development teams').version('0.1.0');
cli.command('serve').description('Start the local API').action(async () => {
  const dataDir = dataDirectory(); const config = await loadConfig();
  const unlock = lockService(dataDir);
  // Recover database writes even when a prior process stopped on a full filesystem.
  await new DiskReserve(dataDir).release();
  const configuredSecrets = config.providers.flatMap(p => p.apiKeyEnv && process.env[p.apiKeyEnv] ? [process.env[p.apiKeyEnv]!] : []);
  const store = new Store(join(dataDir, 'devagents.db'), [...environmentSecrets(), ...configuredSecrets]);
  const sandbox = { scanLimit: config.workspaceScanLimit };
  const engines = new EngineRegistry([new CodexAdapter(dataDir, 'codex', sandbox), new ClaudeAdapter(dataDir, sandbox)]);
  const service = new TaskService(store, config, dataDir, process.platform, engines.ids());
  const credentialRuntime = process.env.DEVAGENTS_CREDENTIAL_RUNTIME;
  const runner = new TaskRunner(service, engines, new CodexValidator(dataDir, 'codex', sandbox), undefined, {
    startPaused: true,
    admission: () => credentialRuntime && !existsSync(join(credentialRuntime, 'unlocked'))
      ? 'Waiting for credential vault unlock; finish startup in the launcher' : undefined,
  });
  service.attachRunner(runner);
  // Docker explicitly binds to all container interfaces; Compose exposes only host loopback.
  const host = process.env.DEVAGENTS_HOST ?? '127.0.0.1';
  if (!['127.0.0.1', '0.0.0.0'].includes(host)) throw new AppError('invalid_host', 'Unsupported bind address');
  const here = dirname(fileURLToPath(import.meta.url));
  const uiRoot = await findUiRoot([resolve(here, '../ui'), resolve(here, '../../dist/ui'), resolve(here, '../../ui/dist')]);
  // Docker listens on 4310 inside the container; Compose publishes DEVAGENTS_PORT on the host loopback.
  const publicPort = z.coerce.number().int().min(1).max(65535).parse(process.env.DEVAGENTS_PUBLIC_PORT ?? port());
  const assertSetupIdle = () => {
    if (runner.busy || store.summaries({ states: ['planning', 'ready', 'running', 'validating', 'reviewing', 'repairing', 'committing'], limit: 1 }).tasks.length) throw new AppError('work_active', 'Finish or cancel active work before changing sign-in.', 409);
  };
  const setupAuth = new SetupAuth(codexSetupDriver(dataDir), () => assertSignInIdle(store, runner));
  const claudeAuth = new SetupAuth(claudeSetupDriver(dataDir), () => assertSignInIdle(store, runner));
  const secretStore = await configuredSecretStore(dataDir);
  const integrations = new ProjectIntegrationService(store, secretStore); const trackers = new TrackerService(store, secretStore);
  // A task started from a ticket takes the ticket's pictures and short text files with it while it works.
  service.attachTicketFiles((task, directory) => downloadTicketFiles({ integrations, trackers }, task.projectId, task.ticket!, directory));
  const providerOf = (kind: string) => config.providers.find(p => p.kind === kind && !p.baseUrl);
  const models = new ModelCatalogService(store, { codex: codexModelLister(dataDir, providerOf('openai')), 'claude-code': claudeModelLister(dataDir, providerOf('anthropic')) });
  const server = createApi(service, await accessToken(dataDir), {
    sessions: new BrowserSessions(undefined, sessionLimits(), sessionFile(dataDir)), uiRoot, publicPort, setupAuth, claudeAuth, assertSetupIdle,
    integrations, trackers, models,
    status: statusReporter({ dataDir, config, version: '0.1.0', host, port: () => publicPort, executionEnabled: true, revision: () => setupAuth.revision + claudeAuth.revision }),
  });
  await service.agents();
  await service.initializeStarterTeam();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port(), host, resolve); });
  // Only the process which owns the listening socket may reconcile this service's tasks.
  const recovered = store.recover();
  await runner.recover();
  await service.diskReserve.replenish();
  log('service_started', { host, port: port(), publicPort, recovered, projects: store.projects().length, executionEnabled: true, ui: uiRoot ? `http://127.0.0.1:${publicPort}/ui/` : 'not built' });
  log('setup', { message: 'Register an existing checkout and authenticate Codex. Use tasks submit, show and evidence to follow work. Open the browser UI with a one-time link from: devagents ui' });
  let closing = false;
  const shutdown = () => {
    if (closing) return; closing = true;
    void claudeAuth.close(); void setupAuth.close(); void runner.stop();
    server.close(() => { void Promise.all([runner.stop(), setupAuth.close(), claudeAuth.close()]).then(() => { store.close(); unlock(); process.exitCode = 0; }); });
    server.closeIdleConnections();
  };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
});
cli.command('ui').description('Create a one-time sign-in link for the browser UI (never exposes the CLI token)').option('--open', 'Open the link with the OS browser').option('--setup', 'Open guided setup').action(async (opts: { open?: boolean; setup?: boolean }) => {
  const link = await request('/ui/bootstrap', 'POST', opts.setup ? { setup: true } : {}) as { url: string; expiresInSeconds: number };
  console.log(link.url);
  console.error(`Single use, valid for ${Math.round(link.expiresInSeconds / 60)} minutes. Once opened, the browser stays signed in until you sign out.`);
  if (!opts.open) return;
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  const child = spawn(opener, [link.url], { stdio: 'ignore', detached: true });
  child.once('error', () => console.error('Could not open a browser automatically; open the link above manually.'));
  child.unref();
});
cli.command('setup-status').action(async () => {
  const status = await request('/setup/auth') as { connection: { saved: boolean }; locked?: boolean };
  const claude = await request('/setup/claude-auth') as { connection: { saved: boolean }; locked?: boolean };
  const projects = await request('/projects') as unknown[];
  console.log(((status.connection.saved && !status.locked) || (claude.connection.saved && !claude.locked)) && projects.length ? 'ready' : 'needed');
});
cli.command('mount-done').action(async () => { await request('/setup/maintenance/release', 'POST', {}); });
cli.command('mount-ready').action(async () => { await request('/setup/maintenance', 'POST', {}); });
async function sharedLogin(method: 'chatgpt' | 'api-key', key?: string) {
  const attemptId = randomUUID();
  let job = await request('/setup/auth', 'POST', { attemptId, method, ...(key ? { apiKey: key } : {}) }) as AuthJob;
  let shown = false; const cancel = () => { void request('/setup/auth/cancel', 'POST', {}).catch(() => {}); };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    while (job.state === 'running') {
      if (job.challenge && !shown) { console.log(`Open ${job.challenge.url} and enter the one-time code: ${job.challenge.code}`); shown = true; }
      await new Promise(resolve => setTimeout(resolve, 1000));
      const status = await request('/setup/auth') as { job?: AuthJob };
      if (!status.job || status.job.attemptId !== attemptId) throw new AppError('login_interrupted', 'Sign-in state was lost. Start setup again.');
      job = status.job;
    }
    if (job.state !== 'completed') throw new AppError('login_failed', job.message);
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
cli.command('doctor').description('Report configuration and engine setup').action(async () => {
  const config = await loadConfig();
  const health = await engineHealth(dataDirectory());
  print({ node: process.version, platform: `${process.platform}/${process.arch}`, ...health, providers: config.providers.map(p => ({ id: p.id, kind: p.kind, auth: p.auth, apiKeyConfigured: p.apiKeyEnv ? Boolean(process.env[p.apiKeyEnv]) : null, localExecution: ['ollama', 'openai-compatible'].includes(p.kind) ? 'planned-follow-up' : undefined })), next: 'Start with npm run dev; register a project with npm run cli -- projects add <id> <absolute-path>' });
});
type ProjectRow = { id: string; name: string; path: string; version: number; archivedAt?: string };
/** Commands take a project by its name or its ID. A name is matched without regard to case; an active project wins over an archived one. */
async function projectRef(ref: string): Promise<ProjectRow> {
  const all = await request('/projects?filter=all') as ProjectRow[];
  const byId = all.find(p => p.id === ref); if (byId) return byId;
  const named = all.filter(p => p.name.toLowerCase() === ref.trim().toLowerCase()); const active = named.filter(p => !p.archivedAt);
  const found = active.length === 1 ? active[0] : named.length === 1 ? named[0] : undefined;
  if (found) return found;
  throw new AppError(named.length ? 'ambiguous_project' : 'not_found', named.length ? `Several projects are named "${ref}". Use the ID instead: ${named.map(p => p.id).join(', ')}` : `No project has the name or ID "${ref}". List them with: projects list`);
}
const pid = async (ref: string) => (await projectRef(ref)).id;
/** API errors arrive as JSON; commands the launcher runs print only the message. */
const plain = (error: unknown): string => { const text = error instanceof Error ? error.message : String(error); try { return String((JSON.parse(text) as { message?: unknown }).message ?? text); } catch { return text; } };
const projects = cli.command('projects');
projects.command('list').option('--archived', 'Only archived projects').option('--all', 'Active and archived projects').action(async (opts: { archived?: boolean; all?: boolean }) => print(await request(`/projects?filter=${opts.all ? 'all' : opts.archived ? 'archived' : 'active'}`)));
projects.command('add <name> <path>').description('Register an existing checkout under a name; the service generates the project ID').option('--mode <mode>', 'Optional project autonomy default').action(async (name: string, path: string, opts: { mode?: string }) => print(await request('/projects', 'POST', { name, path, ...(opts.mode ? { defaultMode: opts.mode } : {}) })));
projects.command('rename <project> <name>').description('Change a project\'s name; its ID, history and folder stay as they are').action(async (project: string, name: string) => {
  const current = await projectRef(project);
  print(await request(`/projects/${encodeURIComponent(current.id)}/name`, 'PUT', { name, expectedVersion: current.version }));
});
async function setArchived(ref: string, archived: boolean): Promise<ProjectRow> {
  const project = await projectRef(ref);
  await request(`/projects/${encodeURIComponent(project.id)}/archive`, 'POST', { archived, expectedVersion: project.version });
  return project;
}
projects.command('archive <project>').description('Take a project out of use: history and ID are kept, connections are removed, and its folder can be registered again as a new project').action(async (ref: string) => {
  try { const project = await setArchived(ref, true); console.log(`Project "${project.name}" is archived. Its task history is kept. Restore it with: projects restore ${project.id}`); }
  catch (error) { console.error(plain(error)); process.exitCode = 1; }
});
projects.command('restore <project>').description('Bring an archived project back; refused while an active project uses the same folder').action(async (ref: string) => {
  try { const project = await setArchived(ref, false); console.log(`Project "${project.name}" is active again. Reconnect GitHub or Jira on its page if you use them.`); }
  catch (error) { console.error(plain(error)); process.exitCode = 1; }
});
// The three commands below serve the Docker launcher, which must know the ID before it can attach the folder.
projects.command('prepare <name>').description('Check a new project name and print a fresh project ID (used by the launcher)').action(async (name: string) => {
  try { console.log((await request('/projects/prepare', 'POST', { name }) as { id: string }).id); }
  catch (error) { console.error(plain(error)); process.exitCode = 1; }
});
projects.command('launcher-info').description('Archived project folders and project names by path, as JSON (used by the launcher)').action(async () => {
  const all = await request('/projects?filter=all') as ProjectRow[];
  console.log(JSON.stringify({ archived: all.filter(p => p.archivedAt).map(p => p.path), names: Object.fromEntries(all.map(p => [p.path, p.name])) }));
});
projects.command('sync-folders').description('Record each project\'s folder on this computer from the Compose configuration on stdin (used by the launcher)').action(async () => {
  let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > 1024 * 1024) throw new AppError('invalid_input', 'Compose configuration is too large'); }
  const folders = hostFolders(JSON.parse(input));
  if (Object.keys(folders).length) await request('/projects/host-folders', 'PUT', { folders });
});
projects.command('ensure <id> <path>').description('Register a launcher-mounted checkout, or confirm its existing registration').option('--name <name>', 'Project name; defaults to the ID').action(async (id: string, path: string, opts: { name?: string }) => {
  const projects = await request('/projects?filter=all') as ProjectRow[];
  const existing = projects.find(p => p.id === id);
  if (existing?.archivedAt) throw new AppError('project_archived', `The ID ${id} belongs to an archived project. Restore it or register a new project.`);
  if (existing && existing.path !== path) throw new AppError('project_conflict', 'That project ID already belongs to another path.');
  if (!existing) await request('/projects', 'POST', { id, path, defaultMode: 'plan-approval', ...(opts.name ? { name: opts.name } : {}) });
  console.log(`Project "${opts.name ?? existing?.name ?? id}" is registered with plan approval for new registrations.`);
});
projects.command('default-team <project> <team>').description('Set a saved team as the project default, or "none" to clear it').requiredOption('--version <version>', 'Project settings version you looked at').action(async (project: string, team: string, opts: { version: string }) => print(await request(`/projects/${encodeURIComponent(await pid(project))}/default-team`, 'PUT', { teamId: team === 'none' ? null : team, expectedVersion: Number(opts.version) })));
// Project integrations: the same routes the browser uses. A token is typed into a hidden prompt or read
// from an environment variable; it is never a command-line argument and never printed.
async function integrationToken(label: string, opts: { tokenEnv?: string; keepToken?: boolean; savedToken?: string }): Promise<string | undefined> {
  if (opts.keepToken || opts.savedToken) return undefined;
  if (opts.tokenEnv) {
    const value = process.env[opts.tokenEnv];
    if (!value) throw new AppError('missing_token', 'The selected token environment variable is empty');
    return value;
  }
  if (!process.stdin.isTTY) throw new AppError('terminal_required', 'Token entry needs an interactive terminal. Pass --token-env <NAME> to read it from an environment variable, --saved-token <id> to reuse one, or --keep-token to check the current one.');
  return readHiddenKey(process.stdin, process.stderr, label);
}
const integrationPath = (project: string, rest = '') => `/projects/${encodeURIComponent(project)}/integrations${rest}`;
const integrations = cli.command('integrations').description('Connect a project to GitHub and Jira. Stores and checks the connection; nothing is pushed and no task is created');
integrations.command('show <project>').description('Connections, their last check and the saved Jira pick-up rule').action(async (project: string) => print(await request(integrationPath(await pid(project)))));
const github = integrations.command('github').description('GitHub token for a project whose folder is already cloned');
github.command('connect <project>').description('Verify and save a GitHub token (starts with github_pat_ or ghp_)')
  .option('--repository <owner/name>', 'Only needed when the folder has no GitHub remote named origin')
  .option('--token-env <name>', 'Read the token from this environment variable instead of the hidden prompt')
  .option('--saved-token <id>', 'Reuse a token already saved for another project on the same account; ids are listed by: integrations show')
  .option('--keep-token', 'Check the current token again, for example after changing the repository')
  .action(async (project: string, opts: { repository?: string; tokenEnv?: string; keepToken?: boolean; savedToken?: string }) => {
    const token = await integrationToken('your GitHub token', opts);
    print(await request(integrationPath(await pid(project), '/github'), 'PUT', { ...(token ? { token } : {}), ...(opts.savedToken ? { savedToken: opts.savedToken } : {}), ...(opts.repository ? { repository: opts.repository } : {}) }));
  });
github.command('check <project>').description('Ask GitHub whether the saved token still works').action(async (project: string) => print(await request(integrationPath(await pid(project), '/github/check'), 'POST', {})));
github.command('disconnect <project>').description('Forget this project\'s connection; the token is forgotten once no project uses it').action(async (project: string) => print(await request(integrationPath(await pid(project), '/github'), 'DELETE')));
const jira = integrations.command('jira').description('Jira token and the rule that says which tickets may become tasks');
jira.command('connect <project>').description('Verify and save a Jira token: an Atlassian API token for Jira Cloud, a personal access token for self-hosted Jira')
  .option('--site <address>', 'Jira address, for example example.atlassian.net; not needed with --saved-token')
  .option('--saved-token <id>', 'Reuse a token already saved for another project, with its site and account; ids are listed by: integrations show')
  .option('--email <email>', 'Jira Cloud: email of the Atlassian account that owns the token')
  .option('--self-hosted', 'Jira Data Center: personal access token, no email')
  .option('--expires <date>', 'End date of the token (YYYY-MM-DD), for the reminder; Atlassian does not report it')
  .option('--token-env <name>', 'Read the token from this environment variable instead of the hidden prompt')
  .option('--keep-token', 'Check the current token again')
  .action(async (project: string, opts: { site?: string; email?: string; selfHosted?: boolean; expires?: string; tokenEnv?: string; keepToken?: boolean; savedToken?: string }) => {
    if (opts.savedToken) { print(await request(integrationPath(await pid(project), '/jira'), 'PUT', { savedToken: opts.savedToken })); return; }
    if (!opts.site) throw new AppError('invalid_options', 'Pass --site <address>, or --saved-token <id> to reuse a saved token');
    const token = await integrationToken(opts.selfHosted ? 'your Jira personal access token' : 'your Atlassian API token', opts);
    print(await request(integrationPath(await pid(project), '/jira'), 'PUT', { kind: opts.selfHosted ? 'data-center' : 'cloud', site: opts.site, ...(opts.email ? { email: opts.email } : {}), ...(opts.expires ? { expiresOn: opts.expires } : {}), ...(token ? { token } : {}) }));
  });
jira.command('options <project>').description('Jira projects; with --project also its columns, people and labels').option('--project <key>', 'Jira project key, for example WEB')
  .action(async (project: string, opts: { project?: string }) => print(await request(integrationPath(await pid(project), `/jira/options${opts.project ? `?project=${encodeURIComponent(opts.project)}` : ''}`))));
jira.command('search <project> <kind> [text]').description('Look up Jira projects, people or labels by what you type; people need --project')
  .option('--project <key>', 'Jira project key, for example WEB')
  .action(async (project: string, kind: string, text: string | undefined, opts: { project?: string }) => {
    const query = new URLSearchParams({ kind, query: text ?? '', ...(opts.project ? { project: opts.project } : {}) });
    print(await request(integrationPath(await pid(project), `/jira/suggest?${query}`)));
  });
jira.command('rule <project>').description('Save which tickets may become tasks; --column, --assignee and --label are optional, and without them the open tickets of the project match')
  .requiredOption('--project <key>', 'Jira project key, for example WEB')
  .option('--column <name>', 'Board column, for example "Ready for agents"')
  .option('--assignee <name-or-id>', 'Jira user by display name or id')
  .option('--label <label>', 'Jira label')
  .addOption(new Option('--start <mode>', 'manual: wait until someone starts it; auto: start on its own').choices(['manual', 'auto']).default('manual'))
  .option('--preview', 'Only show what the rule matches now; save nothing')
  .action(async (project: string, opts: { project: string; column?: string; assignee?: string; label?: string; start: string; preview?: boolean }) => {
    const rule = { project: opts.project, start: opts.start, ...(opts.column ? { column: opts.column } : {}), ...(opts.assignee ? { assignee: opts.assignee } : {}), ...(opts.label ? { label: opts.label } : {}) };
    print(await request(integrationPath(await pid(project), opts.preview ? '/jira/preview' : '/jira/rule'), opts.preview ? 'POST' : 'PUT', rule));
  });
jira.command('remove-rule <project>').description('Forget the pick-up rule and keep the connection; no tickets come from Jira until a rule is saved again').action(async (project: string) => print(await request(integrationPath(await pid(project), '/jira/rule'), 'DELETE')));
jira.command('check <project>').description('Ask Jira whether the saved token still works').action(async (project: string) => print(await request(integrationPath(await pid(project), '/jira/check'), 'POST', {})));
// Ticket tools reached through their MCP server: added once, then used by projects.
const toolRef = async (ref: string): Promise<string> => {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(ref)) return ref;
  const { trackers } = await request('/trackers') as { trackers: { id: string; name: string }[] };
  const found = trackers.filter(t => t.name.toLowerCase() === ref.toLowerCase());
  if (found.length !== 1) throw new AppError('tracker_not_found', `No tool named "${ref}". List them with: devagents tools list`, 404);
  return found[0]!.id;
};
cli.command('tickets').description('Tickets that match a project\'s pick-up rule and have no task yet; nothing is started').action(async () => print(await request('/tickets/available')));
cli.command('ticket <project> <source> <number>').description('Read one ticket with its text and comments, as a task started from it would receive them. <source> is jira or the name of a ticket tool; nothing is started')
  .action(async (project: string, source: string, number: string) => print(await request(`/tickets/content?${new URLSearchParams({ projectId: await pid(project), source: source.toLowerCase() === 'jira' ? 'jira' : await toolRef(source), key: number })}`)));
const tools = cli.command('tools').description('Ticket tools with an MCP server (any Jira-like tool). Add one once, then connect projects to it. Stores and checks configuration; no task is created');
tools.command('list').description('Added tools, their state and the projects that use them').action(async () => print(await request('/trackers')));
tools.command('add <name> <url>').description('Sign in to a tool\'s MCP server and show its tools with a proposed mapping')
  .option('--token-env <name>', 'Read the token from this environment variable instead of the hidden prompt')
  .action(async (name: string, url: string, opts: { tokenEnv?: string }) => {
    const token = await integrationToken(`the token for ${name}`, opts);
    print(await request('/trackers', 'POST', { name, url, ...(token ? { token } : {}) }));
  });
tools.command('show <tool>').description('One tool with its saved mapping').action(async (tool: string) => print(await request(`/trackers/${await toolRef(tool)}`)));
tools.command('inspect <tool>').description('The server\'s tools, the outline of the ticket list answer and a proposed mapping').action(async (tool: string) => print(await request(`/trackers/${await toolRef(tool)}/inspect`)));
tools.command('map <tool>').description('Save the mapping: which tool lists tickets and where the ticket fields are')
  .option('--suggested', 'Save the mapping DevAgents proposes')
  .option('--file <path>', 'Save the mapping from a JSON file, in the shape "inspect" prints as suggestion')
  .action(async (tool: string, opts: { suggested?: boolean; file?: string }) => {
    const id = await toolRef(tool);
    if (Boolean(opts.suggested) === Boolean(opts.file)) throw new AppError('invalid_options', 'Pass either --suggested or --file <path>');
    const mapping = opts.file ? JSON.parse(await readFile(opts.file, 'utf8')) as unknown : (await request(`/trackers/${id}/inspect`) as { suggestion?: unknown; note?: string }).suggestion;
    if (!mapping) throw new AppError('no_suggestion', 'DevAgents could not propose a mapping for this tool. Write one and pass it with --file; "tools inspect" shows the tools and fields.', 422);
    print(await request(`/trackers/${id}/mapping`, 'PUT', mapping));
  });
tools.command('rename <tool> <name>').description('Change the name shown for a tool').action(async (tool: string, name: string) => print(await request(`/trackers/${await toolRef(tool)}`, 'PUT', { name })));
tools.command('address <tool> <url>').description('Change the MCP address of a tool; DevAgents signs in there first, with the saved token').action(async (tool: string, url: string) => print(await request(`/trackers/${await toolRef(tool)}`, 'PUT', { url })));
tools.command('token <tool>').description('Replace the saved token; it is verified first')
  .option('--token-env <name>', 'Read the token from this environment variable instead of the hidden prompt')
  .action(async (tool: string, opts: { tokenEnv?: string }) => print(await request(`/trackers/${await toolRef(tool)}`, 'PUT', { token: await integrationToken('the new token', opts) })));
tools.command('check <tool>').description('Ask the tool whether the saved token and mapping still work').action(async (tool: string) => print(await request(`/trackers/${await toolRef(tool)}/check`, 'POST', {})));
tools.command('remove <tool>').description('Remove a tool and forget its token; refused while a project uses it').action(async (tool: string) => print(await request(`/trackers/${await toolRef(tool)}`, 'DELETE')));
const tracker = integrations.command('tool').description('Connect a project to added ticket tools and say which tickets may become tasks. A project can use several tools');
const toolPath = async (project: string, tool: string, rest = '') => integrationPath(await pid(project), `/trackers/${await toolRef(tool)}${rest}`);
tracker.command('list <project>').description('The tools this project uses, with their rules, and every added tool').action(async (project: string) => print(await request(integrationPath(await pid(project), '/trackers'))));
tracker.command('connect <project> <tool>').description('Use an added tool for this project; its address and token are already saved').action(async (project: string, tool: string) => print(await request(await toolPath(project, tool), 'PUT', {})));
tracker.command('options <project> <tool>').description('Projects, columns, people and labels a rule can name').action(async (project: string, tool: string) => print(await request(await toolPath(project, tool, '/options'))));
tracker.command('rule <project> <tool>').description('Save which tickets may become tasks. Every filter is optional and takes several values; with none, every ticket the account can see matches')
  .option('--project <name-or-id...>', 'Projects in the tool; a ticket of any of them matches')
  .option('--column <name...>', 'Board columns; a ticket in any of them matches')
  .option('--assignee <name-or-id...>', 'People; a ticket assigned to any of them matches')
  .option('--label <label...>', 'Labels; a ticket with any of them matches')
  .addOption(new Option('--start <mode>', 'manual: wait until someone starts it; auto: start on its own').choices(['manual', 'auto']).default('manual'))
  .option('--preview', 'Only show what the rule matches now; save nothing')
  .action(async (project: string, tool: string, opts: { project?: string[]; column?: string[]; assignee?: string[]; label?: string[]; start: string; preview?: boolean }) => {
    const rule = { start: opts.start, ...(opts.project ? { projects: opts.project } : {}), ...(opts.column ? { columns: opts.column } : {}), ...(opts.assignee ? { assignees: opts.assignee } : {}), ...(opts.label ? { labels: opts.label } : {}) };
    print(await request(await toolPath(project, tool, opts.preview ? '/preview' : '/rule'), opts.preview ? 'POST' : 'PUT', rule));
  });
tracker.command('remove-rule <project> <tool>').description('Forget the pick-up rule and keep the connection; no tickets come from the tool until a rule is saved again').action(async (project: string, tool: string) => print(await request(await toolPath(project, tool, '/rule'), 'DELETE')));
tracker.command('disconnect <project> <tool>').description('Stop using one tool for this project; the tool itself stays').action(async (project: string, tool: string) => print(await request(await toolPath(project, tool), 'DELETE')));
jira.command('disconnect <project>').description('Forget this project\'s connection and rule; the token is forgotten once no project uses it').action(async (project: string) => print(await request(integrationPath(await pid(project), '/jira'), 'DELETE')));
const teams = cli.command('teams').description('Saved teams: named rosters copied from templates or custom roles');
teams.command('list').option('--archived', 'Only archived teams').option('--all', 'Active and archived teams').action(async (opts: { archived?: boolean; all?: boolean }) => print(await request(`/teams?filter=${opts.all ? 'all' : opts.archived ? 'archived' : 'active'}`)));
teams.command('templates').description('Registry agents as copyable member templates').option('--project <name-or-id>').action(async (opts: { project?: string }) => print(await request(`/teams/templates${opts.project ? `?projectId=${encodeURIComponent(await pid(opts.project))}` : ''}`)));
teams.command('show <id>').action(async (id: string) => print(await request(`/teams/${id}`)));
teams.command('check <file>').description('Server readiness diagnostics for a team file without saving it').action(async (file: string) => print(await request('/teams/check', 'POST', parse(await readFile(file, 'utf8')))));
teams.command('create <file>').description('Create a team from a YAML or JSON file (name, description, members)').action(async (file: string) => print(await request('/teams', 'POST', parse(await readFile(file, 'utf8')))));
teams.command('edit <id> <file>').requiredOption('--revision <revision>', 'Revision you edited; a newer one is a conflict').action(async (id: string, file: string, opts: { revision: string }) => print(await request(`/teams/${id}`, 'PUT', { expectedRevision: Number(opts.revision), team: parse(await readFile(file, 'utf8')) })));
teams.command('archive <id>').requiredOption('--revision <revision>').action(async (id: string, opts: { revision: string }) => print(await request(`/teams/${id}/archive`, 'POST', { expectedRevision: Number(opts.revision), archived: true })));
teams.command('restore <id>').requiredOption('--revision <revision>').action(async (id: string, opts: { revision: string }) => print(await request(`/teams/${id}/archive`, 'POST', { expectedRevision: Number(opts.revision), archived: false })));
teams.command('duplicate <id> <name>').action(async (id: string, name: string) => print(await request(`/teams/${id}/duplicate`, 'POST', { name })));
cli.command('agents').option('--project <name-or-id>').action(async (opts: { project?: string }) => print(await request(`/agents${opts.project ? `?projectId=${encodeURIComponent(await pid(opts.project))}` : ''}`)));
const configCommand = cli.command('config').description('View or update persistent service settings');
configCommand.command('task-concurrency [limit]').description('Show or set concurrent tasks (1–8); applies without restart').action(async (limit?: string) => {
  const maxConcurrentTasks = limit === undefined ? undefined : z.coerce.number().int().min(1).max(8).parse(limit);
  const current = await request('/settings/task-concurrency') as { version: number };
  print(maxConcurrentTasks === undefined ? current : await request('/settings/task-concurrency', 'PUT', { maxConcurrentTasks, expectedVersion: current.version }));
});
cli.command('scheduler').description('Show task capacity, queued work and recovery attention').action(async () => print(await request('/scheduler')));
const tasks = cli.command('tasks');
tasks.command('list').description('Summaries of all tasks; use tasks show for the full record').action(async () => print(await request('/tasks')));
tasks.command('submit <project> <request>').option('--mode <mode>').option('--team <id>', 'Saved team to freeze for this task (default: the project default, else the legacy registry)').option('--key <key>', 'Retry key; reuse it to avoid duplicate submissions').action(async (project: string, text: string, opts: { mode?: string; team?: string; key?: string }) => {
  const task = await request('/tasks', 'POST', { projectId: await pid(project), request: text, ...(opts.mode ? { mode: opts.mode } : {}), ...(opts.team ? { teamId: opts.team } : {}) }, opts.key ?? randomUUID());
  print(task);
  if ((task as { state: string }).state === 'awaiting_mode') console.error('Choose a mode: devagents tasks mode <task-id> autonomous|plan-approval');
});
tasks.command('show <id>').action(async (id: string) => print(await request(`/tasks/${id}`)));
tasks.command('events <id>').action(async (id: string) => print(await request(`/tasks/${id}/events`)));
tasks.command('evidence <id>').action(async (id: string) => print(await request(`/tasks/${id}/evidence`)));
tasks.command('items <id>').description('Show work-item progress, branches and dependency state').action(async (id: string) => print(await request(`/tasks/${id}/items`)));
tasks.command('run <id>').description('Continue an idle planning/ready checkpoint after restart').action(async (id: string) => print(await request(`/tasks/${id}/run`, 'POST', {})));
tasks.command('mode <id> <mode>').action(async (id: string, mode: string) => print(await request(`/tasks/${id}/mode`, 'POST', { mode })));
tasks.command('plan <id> <file>').description('Store a validated plan from YAML or JSON (manual M1 checkpoint)').action(async (id: string, file: string) => print(await request(`/tasks/${id}/plan`, 'POST', parse(await readFile(file, 'utf8')))));
tasks.command('approve <id>').requiredOption('--version <version>', 'Version of the plan you reviewed').action(async (id: string, opts: { version: string }) => print(await request(`/tasks/${id}/approve`, 'POST', { version: Number(opts.version) })));
tasks.command('cancel <id>').action(async (id: string) => print(await request(`/tasks/${id}/cancel`, 'POST', {})));
tasks.command('compact-preview <id>').description('Preview removal of ignored dependencies while keeping source edits and branches').action(async (id: string) => print(await request(`/tasks/${id}/compaction-preview`)));
tasks.command('compact <id>').requiredOption('--digest <digest>', 'Digest from the compaction preview you reviewed').description('Remove only previewed regenerable dependencies; keep worktrees and history').action(async (id: string, opts: { digest: string }) => print(await request(`/tasks/${id}/compact`, 'POST', { digest: opts.digest })));
tasks.command('cleanup <id>').description('Remove a finished task’s managed worktrees and item branches (keeps a completed task’s branch)').action(async (id: string) => print(await request(`/tasks/${id}/cleanup`, 'POST', {})));
const auth = cli.command('auth');
auth.command('vault-exists').description('Report whether encrypted credentials exist').action(async () => {
  const vault = await configuredVault(dataDirectory());
  if (!vault) throw new AppError('vault_unconfigured', 'Use the Compose launcher for encrypted container storage');
  console.log(await vault.exists() || await (await configuredVault(dataDirectory(), 'claude'))!.exists() ? 'yes' : 'no');
});
auth.command('unlock').description('Unlock the memory-backed runtime using a key from stdin').action(async () => {
  const vault = await configuredVault(dataDirectory());
  if (!vault) throw new AppError('vault_unconfigured', 'Use the Compose launcher for encrypted container storage');
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk.toString();
    if (input.length > 128) throw new AppError('invalid_master_key', 'Invalid OS credential-store input');
  }
  await vault.unlock(input.trim());
  await (await configuredVault(dataDirectory(), 'claude'))!.unlock(input.trim());
  // Admission opens only after both vaults have restored their private runtime files.
  await writeFile(join(process.env.DEVAGENTS_CREDENTIAL_RUNTIME!, 'unlocked'), 'ready\n', { mode: 0o600 });
  console.log('Encrypted credential vault unlocked.');
});
auth.command('setup').description('Choose ChatGPT, an API key, or a saved login; optionally test model access')
  .addOption(new Option('--auth <method>', 'Sign-in method').choices(['chatgpt', 'api-key', 'saved']))
  .option('--test-connection', 'Send a small model request using your selected allowance or API credits')
  .option('--replace-key', 'Prompt for a replacement API key even if already signed in')
  .action(async (opts: { replaceKey?: boolean; auth?: AuthChoice; testConnection?: boolean }) => {
    if (opts.replaceKey && opts.auth && opts.auth !== 'api-key') throw new AppError('invalid_options', '--replace-key cannot be combined with another sign-in method');
    try {
      const dataDir = dataDirectory();
      const passed = await onboard({
        status: () => codexAuthStatus(dataDir),
        login: async method => {
          await sharedLogin(method, method === 'api-key' ? await readHiddenKey() : undefined);
        },
        test: method => testCodexConnection(dataDir, method),
      }, { interactive: Boolean(process.stdin.isTTY), write: message => console.log(message), select: selectChoice }, {
        ...((opts.replaceKey || opts.auth) ? { auth: opts.replaceKey ? 'api-key' : opts.auth! } : {}),
        ...(opts.testConnection ? { testConnection: true } : {}),
      });
      if (!passed) process.exitCode = 1;
    } catch (error) {
      console.error(error instanceof AppError ? error.message : 'Setup could not finish. Check Docker and your OS credential store, then run ./devagents start again.');
      process.exitCode = 1;
    }
  });
auth.command('codex').description('Sign in to DevAgents’ dedicated Codex profile').option('--api-key-env <name>', 'Read an API key from this environment variable').action(async (opts: { apiKeyEnv?: string }) => {
  if (!opts.apiKeyEnv) { await sharedLogin('chatgpt'); return; }
  const key = process.env[opts.apiKeyEnv];
  if (!key) throw new AppError('missing_key', 'The selected API key environment variable is empty');
  await sharedLogin('api-key', key);
  console.log('API key saved securely. Model access has not been checked.');
});
auth.command('claude').description('Save a Claude API key or personal subscription token in the running service')
  .addOption(new Option('--method <method>', 'Credential type').choices(['api-key', 'subscription']).default('api-key'))
  .action(async (opts: { method: 'api-key' | 'subscription' }) => {
    if (opts.method === 'subscription') console.log('Generate your personal token with the official Claude CLI: claude setup-token. Do not share it.');
    const credential = await readHiddenKey();
    const id = randomUUID();
    await request('/setup/claude-auth', 'POST', { attemptId: id, method: opts.method, apiKey: credential });
    for (let n = 0; n < 30; n++) {
      const status = await request('/setup/claude-auth') as { job?: AuthJob };
      if (status.job?.attemptId === id && status.job.state !== 'running') {
        if (status.job.state !== 'completed') throw new AppError('login_failed', status.job.message);
        console.log(status.job.message); return;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new AppError('login_pending', 'Check the Claude connection in Settings');
  });
try { await cli.parseAsync(); }
catch (error) { log('error', { message: error instanceof Error ? error.message : String(error) }); process.exitCode = 1; }
