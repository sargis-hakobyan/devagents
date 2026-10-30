import type { AppConfig, TeamDiagnostic, TeamMember, TeamReadiness } from './schemas.js';
import { assertGrantShape, assertSupportedWriteGrant } from './ownership.js';
import { AppError } from './errors.js';
import { independentReviewer, selectImplementer } from './roles.js';

export type RuntimeSupport = {
  config: AppConfig;
  /** DevAgents capabilities with a real backend. */
  capabilities: ReadonlySet<string>;
  /** Engines with an implemented adapter in this build (M4 adds the second one). */
  executableEngines: ReadonlySet<string>;
  platform: NodeJS.Platform;
};
export const resolveEngine = (member: Pick<TeamMember, 'engine'>, config: AppConfig) => member.engine === 'default' ? config.defaultEngine : member.engine;
export const resolveProviderId = (member: Pick<TeamMember, 'provider'>, config: AppConfig) => member.provider === 'default' ? config.defaultProvider : member.provider;
/** A provider is executable today only through the official OpenAI path of the Codex runtime. */
export const providerExecutable = (provider: AppConfig['providers'][number]) => provider.kind === 'openai' && !provider.baseUrl;

/**
 * Validity versus readiness, as the brief distinguishes them: malformed or forbidden members throw
 * (they cannot be saved at all); an incomplete roster saves as a draft with these diagnostics and
 * cannot receive work until every error is gone. Readiness never consults sign-in or model access,
 * which are reported separately and verified only by an actual run.
 */
export function teamReadiness(members: TeamMember[], support: RuntimeSupport): TeamReadiness {
  const diagnostics: TeamDiagnostic[] = [];
  const add = (level: TeamDiagnostic['level'], code: string, message: string, memberId?: string) => diagnostics.push({ level, code, message, ...(memberId ? { memberId } : {}) });
  const ids = new Set<string>();
  for (const m of members) {
    if (ids.has(m.id)) throw new AppError('invalid_team', `Duplicate member ID ${m.id}`);
    ids.add(m.id);
    if (m.delegation.canDelegate && m.delegation.canReceiveTasks) throw new AppError('invalid_team', `Member ${m.id}: nested delegation is not supported; a planner cannot also receive tasks`);
    for (const grant of [...m.permissions.readPaths, ...m.permissions.writePaths]) assertGrantShape(grant);
    if (m.permissions.allowPush) throw new AppError('invalid_team', `Member ${m.id}: push permission is never granted`);
    for (const capability of m.capabilities) if (!support.capabilities.has(capability)) add('error', 'capability_unavailable', `${m.name}: capability "${capability}" has no backend in this build and cannot be fulfilled`, m.id);
    const engine = resolveEngine(m, support.config);
    if (!support.executableEngines.has(engine)) add('error', 'engine_unavailable', `${m.name}: engine "${engine}" is not available for execution (the Claude adapter arrives in M4)`, m.id);
    const providerId = resolveProviderId(m, support.config); const provider = support.config.providers.find(p => p.id === providerId);
    if (!provider) add('error', 'provider_unknown', `${m.name}: provider "${providerId}" is not configured`, m.id);
    else if (!providerExecutable(provider)) add('error', 'provider_unavailable', `${m.name}: provider "${providerId}" (${provider.kind}) is configuration only; execution needs the official OpenAI provider`, m.id);
    for (const grant of m.permissions.writePaths) { try { assertSupportedWriteGrant(grant, support.platform); } catch (error) { add('error', 'write_grant_unsupported', `${m.name}: ${error instanceof Error ? error.message : String(error)}`, m.id); } }
    if (m.enabled && m.model === 'default' && !support.config.defaultModel) add('warning', 'model_not_pinned', `${m.name}: no model is pinned; the runtime default is chosen at execution and recorded as such`, m.id);
    if (!m.enabled) add('warning', 'member_disabled', `${m.name} is disabled and will not be selected`, m.id);
  }
  // Role coverage uses the same selection rules as plan validation and execution: an implementer is
  // any enabled writable worker, and a reviewer must be a different eligible member from the
  // implementer (review runs read-only regardless of the reviewer's own write grants).
  const enabled = members.filter(m => m.enabled);
  if (!enabled.some(m => m.delegation.canDelegate && m.capabilities.includes('planning'))) add('error', 'no_planner', 'No enabled planner: add a member that delegates with the planning capability (Tech Lead template)');
  const implementers = enabled.filter(m => selectImplementer([m], { requiredCapabilities: [] }));
  if (!implementers.length) add('error', 'no_implementer', 'No enabled implementer: add a member that receives tasks and has write permissions');
  if (!independentReviewer(enabled, [])) add('error', 'no_reviewer', 'No enabled reviewer: add a member with the review capability');
  else if (implementers.length && !implementers.some(i => independentReviewer(enabled, [i.id]))) add('error', 'no_independent_reviewer', 'No independent reviewer: the only reviewer is also the only implementer; add a second worker so review is done by a different member');
  return { ready: !diagnostics.some(d => d.level === 'error'), diagnostics };
}
