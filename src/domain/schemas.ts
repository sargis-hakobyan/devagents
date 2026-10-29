import { z } from 'zod';

export const Id = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const Mode = z.enum(['autonomous', 'plan-approval']);
export const State = z.enum(['draft', 'awaiting_mode', 'planning', 'awaiting_plan_approval', 'ready', 'running', 'validating', 'reviewing', 'committing', 'repairing', 'awaiting_external_approval', 'completed', 'failed', 'cancelled']);
export type TaskState = z.infer<typeof State>;
export const Provider = z.strictObject({
  id: Id,
  kind: z.enum(['openai', 'anthropic', 'openai-compatible', 'ollama']),
  auth: z.enum(['api-key', 'login', 'none']),
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  baseUrl: z.url().optional(),
}).superRefine((p, ctx) => {
  if (p.auth === 'api-key' && !p.apiKeyEnv) ctx.addIssue({ code: 'custom', message: 'api-key requires apiKeyEnv' });
  if (p.auth === 'login' && p.kind !== 'openai') ctx.addIssue({ code: 'custom', message: 'Only Codex/OpenAI login is currently supported; use an API key for Anthropic' });
  if (['ollama', 'openai-compatible'].includes(p.kind) && !p.baseUrl) ctx.addIssue({ code: 'custom', message: 'Local/custom providers require baseUrl' });
  if (p.auth === 'none' && ['openai', 'anthropic'].includes(p.kind)) ctx.addIssue({ code: 'custom', message: 'Cloud providers require authentication' });
  if (p.baseUrl && (new URL(p.baseUrl).username || new URL(p.baseUrl).password || !['http:', 'https:'].includes(new URL(p.baseUrl).protocol))) ctx.addIssue({ code: 'custom', message: 'baseUrl must be HTTP(S) without embedded credentials' });
});
// Providers and engines are different registries. Models remain opaque configurable IDs.
export const Config = z.strictObject({
  schemaVersion: z.literal(1),
  defaultMode: Mode.optional(),
  defaultEngine: Id.default('codex'),
  defaultProvider: Id.default('openai'),
  providers: z.array(Provider).default([{ id: 'openai', kind: 'openai', auth: 'login' }]),
  concurrency: z.number().int().min(1).max(8).default(2),
  maxRepairCycles: z.number().int().min(0).max(3).default(1),
  executionTimeoutMs: z.number().int().min(1000).max(3600000).default(600000),
  validationTimeoutMs: z.number().int().min(1000).max(600000).default(120000),
  workspaceScanLimit: z.number().int().min(1000).max(2000000).default(200000),
}).superRefine((c, ctx) => {
  if (new Set(c.providers.map(p => p.id)).size !== c.providers.length) ctx.addIssue({ code: 'custom', message: 'Duplicate provider IDs' });
  if (!c.providers.some(p => p.id === c.defaultProvider)) ctx.addIssue({ code: 'custom', message: 'defaultProvider must exist' });
});
export type AppConfig = z.infer<typeof Config>;
export const ScopedPath = z.string().regex(/^project:\/(?:[^\\\0]*)$/).refine(p => !p.split('/').some(s => s === '..' || s === '.'), 'Path traversal is forbidden');
export const Permissions = z.strictObject({
  readPaths: z.array(ScopedPath).default(['project:/**']),
  writePaths: z.array(ScopedPath).default([]),
  allowCommands: z.boolean().default(false),
  allowPush: z.literal(false).default(false),
});
export const Agent = z.strictObject({
  schemaVersion: z.literal(1), id: Id, name: z.string().min(1).max(100),
  description: z.string().min(1).max(4000), enabled: z.boolean().default(true),
  engine: Id.default('default'), provider: Id.default('default'), model: z.string().min(1).default('default'),
  capabilities: z.array(Id).min(1), instructionsFile: z.string().min(1),
  delegation: z.strictObject({ canReceiveTasks: z.boolean(), canDelegate: z.boolean() }),
  permissions: Permissions, concurrency: z.number().int().min(1).max(8).default(1),
});
export type AgentDefinition = z.infer<typeof Agent> & { instructions: string; source: string };
export const Command = z.strictObject({ executable: z.string().min(1), args: z.array(z.string()).default([]) });
export const WorkItem = z.strictObject({
  id: Id, title: z.string().min(1), description: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1), dependsOn: z.array(Id),
  requiredCapabilities: z.array(Id).min(1), projectId: Id,
  branch: z.string().regex(/^codex\/[a-z0-9][a-z0-9/-]*$/),
  validation: z.array(Command), assignedAgent: Id.optional(), ownedPaths: z.array(ScopedPath).min(1).optional(),
});
export const Integration = z.strictObject({ assignedAgent: Id, validation: z.array(Command).min(1) });
export const Plan = z.strictObject({ summary: z.string().min(1), risks: z.array(z.string()), items: z.array(WorkItem).min(1).max(30), integration: Integration.nullable().optional() });
export type TaskPlan = z.infer<typeof Plan>;
export const ProjectInput = z.strictObject({ id: Id, path: z.string().min(1), defaultMode: Mode.optional() });
export type Project = z.infer<typeof ProjectInput> & { baseSha: string; registeredAt: string };
export const TaskInput = z.strictObject({ projectId: Id, request: z.string().min(1).max(20000), mode: Mode.optional(), acceptanceCriteria: z.array(z.string().min(1)).default([]) });
export type Task = z.infer<typeof TaskInput> & {
  id: string; runId: string; state: TaskState; version: number;
  createdAt: string; updatedAt: string; plan?: TaskPlan;
  workspace?: { path: string; branch: string; baseSha: string };
  agents?: AgentDefinition[];
  outcome?: { commit?: string; files?: string[]; summary?: string; error?: string; repairCycles: number };
};
export type TaskEvent = { sequence: number; taskId: string; runId: string; actor: string; reason: string; state: TaskState; timestamp: string };
