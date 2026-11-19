import { taskExecution } from '../domain/execution.js';
import { taskUsage } from '../domain/usage.js';
import type { SetupAuth } from '../setup/auth.js';
import { createServer, type ServerResponse } from 'node:http';
import { z, ZodError } from 'zod';
import type { TaskService } from '../orchestration/service.js';
import { AppError } from '../domain/errors.js';
import { ProjectId, State, TeamId } from '../domain/schemas.js';
import { environmentSecrets, redactValues, log } from '../telemetry/redact.js';
import { createBrowserAccess, type BrowserAccessOptions } from './browser-access.js';
import { runtimeAccess } from './workspace-gateway.js';
import { terminalStates } from '../domain/lifecycle.js';
import type { SharedTasks } from '../orchestration/shared-tasks.js';
import { body } from './http-body.js';
import { securityHeaders } from './static.js';
import { evidenceMetadata } from './evidence.js';
import type { ProjectIntegrationService } from '../integrations/service.js';
import type { PullRequestService } from '../integrations/pull-requests.js';
import type { TrackerService } from '../integrations/trackers.js';
import type { ModelCatalogService } from '../engines/model-catalog.js';
import { availableTickets } from '../integrations/available.js';
import { readTicket } from '../integrations/tickets.js';
import { ticketPicture } from '../integrations/ticket-files.js';

/** A picture from a ticket is remote content: it is sent as the checked image type only, never sniffed, cached or allowed to run anything. */
function picture(res: ServerResponse, file: { type: string; bytes: Buffer }): void {
  res.writeHead(200, { ...securityHeaders, 'content-type': file.type, 'content-length': String(file.bytes.byteLength), 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'content-disposition': 'inline' });
  res.end(file.bytes);
}
function respond(res: ServerResponse, code: number, data: unknown, extra: Record<string, string>, secrets: readonly string[]): void {
  res.writeHead(code, { ...securityHeaders, 'content-type': 'application/json', 'cache-control': 'no-store', ...extra });
  // Stored rows are already redacted at rest; responses only strip secret values so plans stay readable.
  res.end(JSON.stringify(redactValues(data, secrets)));
}
const EVIDENCE_PREVIEW_BYTES = 16 * 1024; const EVIDENCE_ENTRY_BYTES = 1024 * 1024;
/** List payloads carry a bounded preview of each evidence entry; the single-entry route carries up to 1 MiB. */
function boundEvidence(entry: { sequence: number; kind: string; at: string; data: unknown }, limit: number) {
  const json = JSON.stringify(entry.data ?? null);
  if (Buffer.byteLength(json) <= limit) return entry;
  return { sequence: entry.sequence, kind: entry.kind, at: entry.at, metadata: evidenceMetadata(entry.data), data: { preview: Buffer.from(json).subarray(0, limit).toString('utf8'), bytes: Buffer.byteLength(json) }, truncated: true };
}
const integer = (value: string | null, fallback: number) => { const n = Number(value ?? fallback); return Number.isInteger(n) && n >= 0 ? n : fallback; };

export type ApiOptions = BrowserAccessOptions & {
  workspaceOwnerId?: string;
  privateRuntimeOwner?: string;
  sharedTasks?: SharedTasks;
  setupAuth?: SetupAuth;
  claudeAuth?: SetupAuth;
  assertSetupIdle?: () => void;
  status?: () => Promise<unknown>;
  /** Per-project GitHub and Jira connections; absent on services that do not configure a secret store. */
  integrations?: ProjectIntegrationService;
  pullRequests?: PullRequestService;
  /** Ticket tools reached through their MCP server. */
  trackers?: TrackerService;
  /** Model lists read from the engines on request; absent where no engine can be asked. */
  models?: ModelCatalogService;
};

export function createApi(application: TaskService, token: string, options: ApiOptions = {}) {
  let maintenanceUntil = 0;
  const workspaceFor = application.workspaceFor(options.privateRuntimeOwner || options.sharedLogin ? { ownerId: options.privateRuntimeOwner ?? options.workspaceOwnerId } : 'local');
  // Responses use the store's secret list (environment heuristic plus configured provider keys), the same list applied at rest.
  const secrets = [...new Set([...environmentSecrets(), ...application.store.secrets])];
  const send = (res: ServerResponse, code: number, data: unknown, extra: Record<string, string> = {}) => respond(res, code, data, extra, secrets);
  const endSetup = async (sessionId: string) => {
    await Promise.allSettled([options.setupAuth?.cancel(sessionId), options.claudeAuth?.cancel(sessionId)]);
  };
  const browserAccess = createBrowserAccess(token, options, send, endSetup);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost'); const path = url.pathname;
      if (req.method === 'GET' && path === '/health') return send(res, 200, { status: 'ok', milestone: 'M3', ui: Boolean(options.uiRoot), executionEnabled: application.executionEnabled });
      if (req.method === 'GET' && path === '/') { res.writeHead(302, { ...securityHeaders, location: '/ui/' }); return res.end(); }
      const access = options.privateRuntimeOwner ? runtimeAccess(req, options.privateRuntimeOwner) : await browserAccess(req, res, url);
      if (!access) return;
      const { actor, setupOwner: owner } = access;
      const service = workspaceFor(actor);
      if (options.privateRuntimeOwner && req.method === 'POST' && path === '/internal/session-ended') {
        await endSetup(owner);
        return send(res, 200, { ended: true });
      }
      /** Tasks store the project ID; the name is added on the way out because it can change. */
      const projectNames = () => new Map(service.store.projects().map(p => [p.id, p.name ?? p.id]));
      const named = <T extends { projectId: string }>(task: T, names = projectNames()) => ({ ...task, projectName: names.get(task.projectId) ?? task.projectId });
      const authController = path.startsWith('/setup/claude-auth') ? options.claudeAuth : options.setupAuth;
      const authPath = path.replace('/setup/claude-auth', '/setup/auth');
      if (authPath === '/setup/auth' && req.method === 'GET') return send(res, 200, authController ? await authController.status(owner) : { available: false, busy: false, connection: { saved: false } });
      if (authPath === '/setup/auth' && req.method === 'POST') {
        if (!authController) throw new AppError('setup_unavailable', 'Provider setup is not enabled on this service.', 503);
        const input = await body(req, 8192);
        if (maintenanceUntil > Date.now()) throw new AppError('setup_busy', 'The launcher is updating project mounts. Try again afterwards.', 409);
        if ((authController !== options.setupAuth && options.setupAuth?.busy) || (authController !== options.claudeAuth && options.claudeAuth?.busy)) throw new AppError('setup_busy', 'Another provider sign-in is in progress', 409);
        return send(res, 202, authController.start(owner, input));
      }
      if (authPath === '/setup/auth/cancel' && req.method === 'POST') {
        if (!authController) throw new AppError('setup_unavailable', 'Provider setup is not enabled on this service.', 503);
        return send(res, 200, await authController.cancel(owner));
      }
      if (path === '/setup/maintenance/release' && req.method === 'POST') {
        if (actor.kind !== 'operator') throw new AppError('bearer_required', 'Project mounts are managed by the local launcher.', 403);
        maintenanceUntil = 0; return send(res, 200, { ready: true });
      }
      if (path === '/setup/maintenance' && req.method === 'POST') {
        if (actor.kind !== 'operator') throw new AppError('bearer_required', 'Project mounts are managed by the local launcher.', 403);
        options.assertSetupIdle?.();
        if (options.setupAuth?.busy || options.claudeAuth?.busy || service.store.summaries({ states: ['planning', 'ready', 'running', 'validating', 'reviewing', 'repairing', 'committing'], limit: 1 }).tasks.length) throw new AppError('setup_busy', 'Finish or cancel active work and sign-in before changing project mounts.', 409);
        maintenanceUntil = Date.now() + 120000;
        return send(res, 200, { ready: true });
      }
      const assertExecutionReady = () => { if ((options.setupAuth?.busy || options.claudeAuth?.busy) || maintenanceUntil > Date.now()) throw new AppError('setup_busy', 'Setup is in progress. Retry after it finishes.', 409); };
      if (((options.setupAuth?.busy || options.claudeAuth?.busy) || maintenanceUntil > Date.now()) && req.method === 'POST' && (path === '/tasks' || /^\/tasks\/[^/]+\/(mode|approve|run|plan)$/.test(path))) throw new AppError('setup_busy', 'Setup is in progress. Retry after it finishes.', 409);
      if (req.method === 'GET' && path === '/submission-options') return send(res, 200, service.submissionOptions());
      if (req.method === 'GET' && path === '/projects') {
        const filter = z.enum(['active', 'archived', 'all']).parse(url.searchParams.get('filter') ?? 'active');
        return send(res, 200, service.store.projects().filter(p => filter === 'all' || Boolean(p.archivedAt) === (filter === 'archived')));
      }
      if (req.method === 'PUT' && path === '/projects/host-folders') {
        if (actor.kind !== 'operator') throw new AppError('bearer_required', 'Project folders are reported by the local launcher.', 403);
        const input = z.strictObject({ folders: z.record(z.string().min(1).max(4096), z.string().min(1).max(4096)) }).parse(await body(req));
        if (Object.keys(input.folders).length > 500) throw new AppError('invalid_request', 'Too many folders');
        return send(res, 200, { updated: service.store.setProjectHostPaths(input.folders) });
      }
      if (req.method === 'POST' && path === '/projects/prepare') return send(res, 200, service.prepareProject(z.strictObject({ name: z.unknown() }).parse(await body(req)).name));
      const projectName = /^\/projects\/([a-z0-9][a-z0-9-]{0,63})\/name$/.exec(path);
      if (req.method === 'PUT' && projectName) {
        const change = z.strictObject({ name: z.unknown(), expectedVersion: z.number().int().nonnegative() }).parse(await body(req));
        return send(res, 200, service.renameProject(projectName[1]!, change.name, change.expectedVersion));
      }
      const projectSkillList = /^\/projects\/([a-z0-9][a-z0-9-]{0,63})\/skills$/.exec(path);
      if (req.method === 'GET' && projectSkillList) return send(res, 200, await service.projectSkills(projectSkillList[1]!));
      const projectArchive = /^\/projects\/([a-z0-9][a-z0-9-]{0,63})\/archive$/.exec(path);
      if (req.method === 'POST' && projectArchive) {
        const change = z.strictObject({ archived: z.boolean(), expectedVersion: z.number().int().nonnegative() }).parse(await body(req));
        const project = await service.setProjectArchived(projectArchive[1]!, change.archived, change.expectedVersion);
        // An archived project holds no connections; a token goes only when no other project uses it.
        if (change.archived && options.integrations) for (const kind of ['github', 'jira'] as const) await options.integrations.disconnect(project.id, kind);
        if (change.archived && options.trackers) await options.trackers.disconnect(project.id);
        return send(res, 200, service.store.project(project.id));
      }
      if (req.method === 'POST' && path === '/projects') {
        const input = await body(req);
        // IDs are generated. The launcher sends the UUID it was handed by /projects/prepare; nothing else is accepted as an ID.
        const id = (input as { id?: unknown } | null)?.id;
        if (id !== undefined && !z.uuid().safeParse(id).success) throw new AppError('invalid_project_id', 'Project IDs are generated by the service. Send a name instead of an ID.');
        return send(res, 201, await service.registerProject(input));
      }
      if (req.method === 'GET' && path === '/agents') return send(res, 200, await service.agents(url.searchParams.get('projectId') ?? undefined));
      const projectDefault = /^\/projects\/([a-z0-9][a-z0-9-]{0,63})\/default-team$/.exec(path);
      if (req.method === 'PUT' && projectDefault) {
        const change = z.strictObject({ teamId: TeamId.nullable(), expectedVersion: z.number().int().nonnegative() }).parse(await body(req));
        return send(res, 200, service.setProjectDefaultTeam(projectDefault[1]!, change.teamId, change.expectedVersion));
      }
      // Ticket tools: added once by their MCP address, then used by projects. Tokens are write-only here too.
      const trackerRoute = /^\/trackers(?:\/([0-9a-f-]{36})(?:\/(inspect|mapping|check))?)?$/.exec(path);
      const projectTracker = /^\/projects\/([a-z0-9][a-z0-9-]{0,63})\/integrations\/trackers(?:\/([0-9a-f-]{36})(?:\/(options|preview|rule))?)?$/.exec(path);
      if (trackerRoute || projectTracker) {
        const trackers = options.trackers;
        if (!trackers) throw new AppError('integrations_unavailable', 'Integrations are not enabled on this service.', 503);
        if (trackerRoute) {
          const [, id, action] = trackerRoute;
          if (!id && req.method === 'GET') return send(res, 200, await trackers.list());
          if (!id && req.method === 'POST') return send(res, 201, await trackers.add(await body(req, 16384)));
          if (id && !action && req.method === 'GET') return send(res, 200, await trackers.show(id));
          if (id && !action && req.method === 'PUT') return send(res, 200, await trackers.update(id, await body(req, 16384)));
          if (id && !action && req.method === 'DELETE') return send(res, 200, await trackers.remove(id));
          if (id && action === 'inspect' && req.method === 'GET') return send(res, 200, await trackers.inspect(id));
          if (id && action === 'mapping' && req.method === 'PUT') return send(res, 200, await trackers.setMapping(id, await body(req, 65536)));
          if (id && action === 'check' && req.method === 'POST') return send(res, 200, await trackers.check(id));
        } else if (projectTracker) {
          const [, id, tool, action] = projectTracker as unknown as [string, string, string | undefined, string | undefined];
          if (!tool && req.method === 'GET') return send(res, 200, await trackers.projectView(id));
          if (tool && !action && req.method === 'PUT') return send(res, 200, await trackers.connect(id, tool));
          if (tool && !action && req.method === 'DELETE') return send(res, 200, await trackers.disconnect(id, tool));
          if (tool && action === 'options' && req.method === 'GET') return send(res, 200, await trackers.choices(id, tool));
          if (tool && action === 'preview' && req.method === 'POST') return send(res, 200, await trackers.preview(id, tool, await body(req, 16384)));
          if (tool && action === 'rule' && req.method === 'PUT') return send(res, 200, await trackers.saveRule(id, tool, await body(req, 16384)));
          if (tool && action === 'rule' && req.method === 'DELETE') return send(res, 200, await trackers.removeRule(id, tool));
        }
      }
      // What happens on GitHub after a task finishes, per project and per task.
      const projectPulls = /^\/projects\/([a-z0-9][a-z0-9-]{0,63})\/pull-requests(\/branches)?$/.exec(path);
      const taskPull = /^\/tasks\/([a-f0-9-]{36})\/pull-request(?:\/(rounds|push-round|merge))?$/.exec(path);
      if (projectPulls || taskPull) {
        const pulls = options.pullRequests;
        if (!pulls) throw new AppError('integrations_unavailable', 'Integrations are not enabled on this service.', 503);
        if (projectPulls) {
          const id = service.store.project(projectPulls[1]!).id;
          if (req.method === 'GET') return send(res, 200, projectPulls[2] ? await pulls.branches(id) : pulls.project(id));
          if (req.method === 'PUT' && !projectPulls[2]) return send(res, 200, pulls.save(id, await body(req, 4096)));
        } else {
          const id = service.store.task(taskPull![1]!).id;
          if (req.method === 'GET' && !taskPull![2]) return send(res, 200, pulls.view(id));
          if (req.method === 'POST' && !taskPull![2]) { await pulls.publish(id, 'user'); return send(res, 200, pulls.view(id)); }
          if (req.method === 'POST' && taskPull![2] === 'rounds') { await pulls.startRound(id, await body(req, 16384), 'user'); return send(res, 200, pulls.view(id)); }
          if (req.method === 'POST' && taskPull![2] === 'merge') { await pulls.merge(id, 'user'); return send(res, 200, pulls.view(id)); }
          if (req.method === 'POST' && taskPull![2] === 'push-round') { await pulls.releaseRound(id); return send(res, 200, pulls.view(id)); }
        }
        throw new AppError('method_not_allowed', 'Method not allowed', 405);
      }
      // Project integrations: tokens are write-only; responses carry settings and the last check, never a secret.
      const integration = /^\/projects\/([a-z0-9][a-z0-9-]{0,63})\/integrations(?:\/(github|jira)(?:\/(check|options|columns|suggest|preview|rule))?)?$/.exec(path);
      if (integration) {
        const integrations = options.integrations;
        if (!integrations) throw new AppError('integrations_unavailable', 'Integrations are not enabled on this service.', 503);
        const id = integration[1]!; const kind = integration[2] as 'github' | 'jira' | undefined; const action = integration[3];
        if (req.method === 'GET' && !kind) return send(res, 200, await integrations.view(id));
        if (req.method === 'PUT' && kind && !action) return send(res, 200, kind === 'github' ? await integrations.connectGitHub(id, await body(req, 16384)) : await integrations.connectJira(id, await body(req, 16384)));
        if (req.method === 'DELETE' && kind && !action) return send(res, 200, await integrations.disconnect(id, kind));
        if (req.method === 'POST' && kind && action === 'check') return send(res, 200, kind === 'github' ? await integrations.checkGitHub(id) : await integrations.checkJira(id));
        if (kind === 'jira' && req.method === 'GET' && action === 'options') return send(res, 200, await integrations.jiraChoices(id, url.searchParams.get('project') ?? undefined));
        if (kind === 'jira' && req.method === 'GET' && action === 'columns') return send(res, 200, await integrations.jiraColumnChoices(id, url.searchParams.get('project') ?? ''));
        if (kind === 'jira' && req.method === 'GET' && action === 'suggest') return send(res, 200, await integrations.jiraSuggestions(id, url.searchParams.get('kind'), (url.searchParams.get('query') ?? '').slice(0, 200), url.searchParams.get('project') ?? undefined));
        if (kind === 'jira' && req.method === 'POST' && action === 'preview') return send(res, 200, await integrations.previewJiraRule(id, await body(req, 16384)));
        if (kind === 'jira' && req.method === 'PUT' && action === 'rule') return send(res, 200, await integrations.saveJiraRule(id, await body(req, 16384)));
        if (kind === 'jira' && req.method === 'DELETE' && action === 'rule') return send(res, 200, await integrations.removeJiraRule(id));
      }
      // Saved teams: every mutation is behind the same authentication, CSRF and origin checks as task actions.
      if (req.method === 'GET' && path === '/teams') return send(res, 200, service.teams(z.enum(['active', 'archived', 'all']).parse(url.searchParams.get('filter') ?? 'active')));
      if (req.method === 'POST' && path === '/teams') return send(res, 201, service.createTeam(await body(req)));
      if (req.method === 'POST' && path === '/teams/check') return send(res, 200, service.checkTeam(await body(req)));
      if (req.method === 'GET' && path === '/teams/options') return send(res, 200, service.teamOptions());
      // Reading the saved lists contacts nobody; only the explicit refresh asks an engine.
      if (req.method === 'GET' && path === '/teams/models') return send(res, 200, options.models?.list() ?? []);
      if (req.method === 'POST' && path === '/teams/models/refresh') {
        if (!options.models) throw new AppError('model_list_unavailable', 'Model lists cannot be loaded on this service.', 503);
        return send(res, 200, await options.models.refresh(z.strictObject({ engine: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/) }).parse(await body(req, 1024)).engine));
      }
      if (req.method === 'GET' && path === '/teams/templates') return send(res, 200, await service.templates(url.searchParams.get('projectId') ?? undefined));
      const teamMatch = /^\/teams\/([a-f0-9-]{36})(?:\/(archive|duplicate))?$/.exec(path);
      if (teamMatch) {
        const id = teamMatch[1]!; const action = teamMatch[2];
        if (req.method === 'GET' && !action) return send(res, 200, service.team(id));
        if (req.method === 'PUT' && !action) {
          const change = z.strictObject({ expectedRevision: z.number().int().positive(), team: z.unknown() }).parse(await body(req));
          return send(res, 200, service.updateTeam(id, change.expectedRevision, change.team));
        }
        if (req.method === 'POST' && action === 'archive') {
          const change = z.strictObject({ expectedRevision: z.number().int().positive(), archived: z.boolean() }).parse(await body(req));
          return send(res, 200, service.setTeamArchived(id, change.expectedRevision, change.archived));
        }
        if (req.method === 'POST' && action === 'duplicate') return send(res, 201, service.duplicateTeam(id, z.strictObject({ name: z.unknown() }).parse(await body(req)).name));
      }
      if (req.method === 'GET' && path === '/overview') {
        const scheduler = service.scheduling(); const overview = service.store.overview(scheduler.active);
        const names = projectNames();
        return send(res, 200, { ...overview, scheduler, attention: overview.attention.map(task => named(task, names)), recent: overview.recent.map(task => named(task, names)), active: overview.active.map(task => ({ ...named(task, names), scheduling: service.taskScheduling(task.id) })) });
      }
      if (req.method === 'GET' && path === '/settings/task-concurrency') return send(res, 200, service.taskConcurrency());
      if (req.method === 'PUT' && path === '/settings/task-concurrency') return send(res, 200, service.setTaskConcurrency(await body(req)));
      if (req.method === 'GET' && path === '/scheduler') return send(res, 200, service.scheduling());
      if (req.method === 'GET' && path === '/status') {
        if (!options.status) throw new AppError('not_found', 'Status reporting is not configured', 404);
        return send(res, 200, { ...await options.status() as object, ...(options.privateRuntimeOwner ? { privateWorkspace: true } : {}), ...(options.sharedTasks ? { sharedTaskStorage: { backend: 'postgresql', problem: options.sharedTasks.problem } } : {}), scheduler: service.scheduling() });
      }
      if (req.method === 'GET' && path === '/storage') return send(res, 200, await service.storageStatus());
      // Tickets that match a project's rule and have no task yet. Read only; starting one is a normal task submission.
      if (req.method === 'GET' && path === '/tickets/available') return send(res, 200, await availableTickets(service.store, { integrations: options.integrations, trackers: options.trackers }));
      // One ticket with its text and comments, for the submit form. Read only.
      if (req.method === 'GET' && path === '/tickets/content') {
        const query = z.strictObject({ projectId: ProjectId, source: z.string().min(1).max(60), key: z.string().min(1).max(60) }).parse(Object.fromEntries(url.searchParams));
        return send(res, 200, await readTicket({ integrations: options.integrations, trackers: options.trackers }, service.store.project(query.projectId).id, query.source, query.key));
      }
      // A ticket's picture for the submit form, read from the tool now and not kept.
      if (req.method === 'GET' && path === '/tickets/picture') {
        const query = z.strictObject({ projectId: ProjectId, source: z.string().min(1).max(60), key: z.string().min(1).max(60), index: z.coerce.number().int().min(0).max(99) }).parse(Object.fromEntries(url.searchParams));
        return picture(res, await ticketPicture({ integrations: options.integrations, trackers: options.trackers }, service.store.project(query.projectId).id, query.source, query.key, query.index));
      }
      const taskPicture = /^\/tasks\/([a-f0-9-]{36})\/ticket-files\/(\d{2}\.[a-z]{2,4})$/.exec(path);
      if (req.method === 'GET' && taskPicture) return picture(res, await service.ticketPicture(taskPicture[1]!, taskPicture[2]!));
      if (req.method === 'GET' && path === '/tasks') {
        const states = z.array(State).max(State.options.length).parse(url.searchParams.getAll('state'));
        const project = url.searchParams.get('projectId'); const projectId = project ? ProjectId.parse(project) : undefined;
        const before = url.searchParams.get('before');
        const page = service.store.summaries({
          limit: integer(url.searchParams.get('limit'), 50),
          ...(before ? { before: integer(before, 0) } : {}),
          ...(projectId ? { projectId } : {}),
          ...(states.length ? { states } : {}),
          ...(url.searchParams.get('pullRequest') === 'open' ? { openPullRequest: true } : {}),
        });
        const names = projectNames();
        return send(res, 200, { ...page, tasks: page.tasks.map(task => ({ ...named(task, names), scheduling: service.taskScheduling(task.id) })), counts: service.store.stateCounts(projectId) });
      }
      if (req.method === 'POST' && path === '/tasks') {
        const key = z.string().min(1).max(200).parse(req.headers['idempotency-key']);
        const input = await body(req); assertExecutionReady();
        const task = service.submit(input, key);
        if (options.sharedTasks) await options.sharedTasks.publish(task.id);
        return send(res, 201, named(task));
      }
      const match = /^\/tasks\/([a-f0-9-]{36})(?:\/(events|evidence|items|diff|result|usage|execution|run|mode|plan|approve|cancel|cleanup|compaction-preview|compact)(?:\/(\d{1,12}))?)?$/.exec(path);
      if (match) {
        const id = match[1]!; const action = match[2]; const sub = match[3];
        if (req.method === 'GET' && action === 'result' && !sub) {
          if (!options.sharedTasks) throw new AppError('not_found', 'Shared result storage is not configured', 404);
          const result = await options.sharedTasks.result(id);
          if (!result) throw new AppError('not_found', 'No shared result for this task', 404);
          return send(res, 200, result);
        }
        if (req.method === 'GET' && action === 'execution' && !sub) return send(res, 200, taskExecution(service.store.task(id), service.store.executionEvidence(id)));
        if (req.method === 'GET' && action === 'usage' && !sub) return send(res, 200, taskUsage(service.store.task(id), service.store.usageEvidence(id), service.config));
        if (req.method === 'GET' && action === 'diff' && !sub) {
          if (url.search) throw new AppError('invalid_diff_request', 'Diff requests accept a task ID only; no paths, refs or options');
          return send(res, 200, await service.diff(id));
        }
        if (req.method === 'GET' && action === 'compaction-preview' && !sub) return send(res, 200, await service.compactionPreview(id));
        if (req.method === 'GET' && !action) {
          const local = service.store.task(id);
          const archived = terminalStates.includes(local.state) && options.sharedTasks && service.store.sharedHandoff(id)
            ? await options.sharedTasks.result(id) : undefined;
          const task = archived?.task ?? local;
          return send(res, 200, { ...named(task), approval: service.store.planApproval(id), scheduling: service.taskScheduling(id), ...(service.store.project(task.projectId).archivedAt ? { projectArchived: true } : {}) });
        }
        if (req.method === 'GET' && action === 'events') return send(res, 200, service.store.events(id, integer(url.searchParams.get('after'), 0), Math.min(integer(url.searchParams.get('limit'), 500), 1000)));
        if (req.method === 'GET' && action === 'evidence' && sub) return send(res, 200, boundEvidence(service.store.evidenceEntry(id, Number(sub)), EVIDENCE_ENTRY_BYTES));
        if (req.method === 'GET' && action === 'evidence') return send(res, 200, service.store.evidence(id, integer(url.searchParams.get('after'), 0), Math.min(integer(url.searchParams.get('limit'), 200), 1000)).map(e => boundEvidence(e, EVIDENCE_PREVIEW_BYTES)));
        if (req.method === 'GET' && action === 'items') return send(res, 200, service.store.workItems(id));
        if (req.method === 'POST' && !sub) {
          if (action === 'run') return send(res, 202, service.run(id));
          if (action === 'mode') { const input = await body(req); assertExecutionReady(); return send(res, 200, service.mode(id, z.strictObject({ mode: z.unknown() }).parse(input).mode)); }
          if (action === 'plan') { const input = await body(req); assertExecutionReady(); return send(res, 200, await service.proposePlan(id, input)); }
          if (action === 'approve') { const input = await body(req); assertExecutionReady(); return send(res, 200, service.approve(id, z.strictObject({ version: z.number().int().nonnegative() }).parse(input).version)); }
          if (action === 'cancel') return send(res, 200, service.cancel(id));
          if (action === 'compact') { const input = z.strictObject({ digest: z.string().regex(/^\d{13}\.[a-f0-9]{64}$/) }).parse(await body(req)); return send(res, 200, await service.compact(id, input.digest)); }
          if (action === 'cleanup') return send(res, 200, await service.cleanup(id));
        }
      }
      throw new AppError('not_found', 'Unknown endpoint', 404);
    } catch (error) {
      if (error instanceof ZodError) return send(res, 400, { error: 'validation_error', message: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
      if (error instanceof AppError) return send(res, error.status, { error: error.code, message: error.message });
      log('request_failed', { message: error instanceof Error ? error.message : String(error) });
      send(res, 500, { error: 'internal_error', message: 'Request failed; inspect the service log' });
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  return server;
}
