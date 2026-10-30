/** Same-origin API client. Cookie auth only; the CLI bearer token never exists in the browser. */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export class SignedOutError extends ApiError {
  constructor(message: string) { super(401, 'session_expired', message); }
}
let csrfToken: string | undefined;
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') {
    if (!csrfToken) await session();
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
  }
  const res = await fetch(path, { method, headers, credentials: 'same-origin', ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
  const text = await res.text();
  let data: unknown = undefined;
  try { data = text ? JSON.parse(text) : undefined; } catch { data = undefined; }
  if (res.status === 401) throw new SignedOutError((data as { message?: string } | undefined)?.message ?? 'Signed out');
  if (!res.ok) { const e = data as { error?: string; message?: string } | undefined; throw new ApiError(res.status, e?.error ?? 'request_failed', e?.message ?? `Request failed (${res.status})`); }
  return data as T;
}
export async function session(): Promise<{ authenticated: boolean; csrfToken: string; expiresAt: string }> {
  const s = await api<{ authenticated: boolean; csrfToken: string; expiresAt: string }>('/ui/session');
  csrfToken = s.csrfToken; return s;
}
export async function logout(): Promise<void> {
  try { await api('/ui/logout', { method: 'POST', body: {} }); } finally { csrfToken = undefined; }
}

export type TaskState = 'draft' | 'awaiting_mode' | 'planning' | 'awaiting_plan_approval' | 'ready' | 'running' | 'validating' | 'reviewing' | 'committing' | 'repairing' | 'awaiting_external_approval' | 'completed' | 'failed' | 'cancelled';
export type TaskSummary = { id: string; projectId: string; state: TaskState; version: number; createdAt: string; updatedAt: string; sequence: number; request: string; mode?: 'autonomous' | 'plan-approval'; branch?: string; items?: number; commit?: string; error?: string; team?: TeamRef };
export type TeamRef = { id: string; revision: number; name: string };
export type Command = { executable: string; args: string[] };
export type WorkItem = { id: string; title: string; description: string; acceptanceCriteria: string[]; dependsOn: string[]; requiredCapabilities: string[]; projectId: string; branch: string; validation: Command[]; assignedAgent?: string; ownedPaths?: string[] };
export type Plan = { summary: string; risks: string[]; items: WorkItem[]; integration?: { assignedAgent: string; validation: Command[] } | null };
export type AgentDefinition = { id: string; name: string; description: string; enabled: boolean; engine: string; provider: string; model: string; capabilities: string[]; instructionsFile: string; delegation: { canReceiveTasks: boolean; canDelegate: boolean }; permissions: { readPaths: string[]; writePaths: string[]; allowCommands: boolean; allowPush: boolean }; concurrency: number; instructions: string; source: string };
export type Task = TaskSummary & { approval?: { status: 'not-planned' | 'autonomous' | 'awaiting' | 'approved' | 'not-approved'; timestamp?: string }; request: string; acceptanceCriteria: string[]; runId: string; plan?: Plan; workspace?: { path: string; branch: string; baseSha: string }; agents?: AgentDefinition[]; team?: TeamRef & { snapshotAt: string; members: TeamMember[]; modelPinned: boolean; defaultModel?: string }; outcome?: { commit?: string; files?: string[]; summary?: string; error?: string; repairCycles: number } };
export type TaskEvent = { sequence: number; taskId: string; runId: string; actor: string; reason: string; state: TaskState; timestamp: string };
export type Evidence = { sequence: number; kind: string; at: string; data: unknown; metadata?: Record<string, unknown>; truncated?: boolean };
export type ItemProgress = { itemId: string; state: string; agentId?: string; branch?: string; dependsOn?: string[]; ownedPaths?: string[]; updatedAt?: string; commit?: string; repairCycles?: number; error?: string; reason?: string; workspace?: { path: string; branch: string } };
export type Overview = { counts: Record<string, number>; attention: TaskSummary[]; active: (TaskSummary & { workItems: ItemProgress[] })[]; recent: TaskSummary[] };
export type Project = { id: string; path: string; defaultMode?: 'autonomous' | 'plan-approval'; baseSha: string; registeredAt: string; defaultTeamId?: string; version: number };
export type TeamMember = { id: string; name: string; description: string; enabled: boolean; engine: string; provider: string; model: string; capabilities: string[]; instructions: string; delegation: { canReceiveTasks: boolean; canDelegate: boolean }; permissions: { readPaths: string[]; writePaths: string[]; allowCommands: boolean; allowPush: false }; concurrency: number; origin: 'template' | 'custom'; templateId?: string };
export type TeamDraft = { name: string; description: string; members: TeamMember[] };
export type Diagnostic = { level: 'error' | 'warning'; code: string; message: string; memberId?: string };
export type Readiness = { ready: boolean; diagnostics: Diagnostic[] };
export type TeamSummary = { id: string; name: string; description: string; revision: number; archived: boolean; createdAt: string; updatedAt: string; members: number; enabledMembers: number; readiness: Readiness };
export type TeamDetail = TeamDraft & { id: string; revision: number; archived: boolean; createdAt: string; updatedAt: string; readiness: Readiness; revisions: { revision: number; createdAt: string; reason: string }[] };
export type TeamOptions = { platform: string; defaults: { engine: string; provider: string; model: string | null }; capabilities: string[]; engines: { id: string; executable: boolean; reason: string | null }[]; providers: { id: string; kind: string; auth: string; executable: boolean; reason: string | null }[]; limits: { members: number; instructions: number; capabilities: number } };
export type Status = {
  service: { version: string; host: string; port: number; platform: string; node: string; dataDir: string; executionEnabled: boolean; startedAt: string; checkedAt: string };
  codex: { installed: boolean; version?: string; signedIn: boolean; credentialStore: 'keyring' | 'file'; vaultLocked: boolean; modelAccessVerified: false };
  claude: { installed: boolean; version?: string; enabled: false; note: string };
  defaults: { engine: string; provider: string; model: string | null; providers: { id: string; kind: string; auth: string; apiKeyConfigured: boolean | null; executable: boolean }[] };
  limits: { concurrency: number; maxRepairCycles: number; executionTimeoutMs: number; validationTimeoutMs: number; workspaceScanLimit: number };
  fixture?: { label: string };
};

/** Shared poller keys and loaders, so the shell and a page showing the same resource make one request. */
export const resources = {
  status: { key: 'status', load: () => api<Status>('/status'), intervalMs: 30000 },
  overview: { key: 'overview', load: () => api<Overview>('/overview'), intervalMs: 5000 },
  projects: { key: 'projects', load: () => api<Project[]>('/projects'), intervalMs: 30000 },
  agents: { key: 'agents', load: () => api<AgentDefinition[]>('/agents'), intervalMs: 15000 },
  teams: { key: 'teams', load: () => api<TeamSummary[]>('/teams?filter=all'), intervalMs: 10000 },
  templates: { key: 'templates', load: () => api<TeamMember[]>('/teams/templates'), intervalMs: 60000 },
  teamOptions: { key: 'team-options', load: () => api<TeamOptions>('/teams/options'), intervalMs: 60000 },
};
/** Display label for the roster a task runs with; old tasks have no saved team. */
export const teamLabel = (team: TeamRef | undefined): string => team ? `${team.name} · revision ${team.revision}` : 'Legacy agent configuration';

/** A preview is display text, never a substitute for structured execution facts. */
export const evidenceFacts = (e: Evidence): Record<string, unknown> => e.truncated ? e.metadata ?? {} : (e.data ?? {}) as Record<string, unknown>;
