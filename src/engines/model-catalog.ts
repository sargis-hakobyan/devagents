import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { AppError } from '../domain/errors.js';
import type { AppConfig } from '../domain/schemas.js';
import type { EngineModel, ModelCatalog } from '../domain/model-catalog.js';
import type { Store } from '../persistence/store.js';
import { configuredVault, credentialStore } from '../security/credential-vault.js';
import { claudeCredential } from './claude/credentials.js';
import { runtimeHome, safeEnvironment } from './codex/sandbox.js';

export type ModelLister = (signal: AbortSignal) => Promise<EngineModel[]>;
type Provider = AppConfig['providers'][number];
const LIST_TIMEOUT_MS = 30000;
const clean = (models: EngineModel[]): EngineModel[] => {
  const seen = new Set<string>(); const out: EngineModel[] = [];
  for (const m of models) {
    const id = String(m.id ?? '').trim(); const name = String(m.name ?? '').trim().slice(0, 100);
    if (!id || id.length > 200 || id === 'default' || seen.has(id)) continue;
    seen.add(id); out.push({ id, name: name || id });
  }
  return out.slice(0, 100);
};

/** Codex has no list command; its app-server answers `model/list` over newline-delimited JSON-RPC on standard input and output. */
export function codexModelLister(dataDir: string, provider: Provider | undefined, binary = 'codex'): ModelLister {
  return async signal => {
    if (!provider) throw new AppError('provider_unknown', 'No OpenAI connection is configured for Codex');
    await (await configuredVault(dataDir))?.assertUnlocked();
    const home = runtimeHome(dataDir); const temp = await mkdtemp(join(tmpdir(), 'devagents-models-'));
    const env = safeEnvironment(home, temp);
    if (credentialStore() === 'keyring') env.HOME = homedir();
    const key = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined;
    if (provider.auth === 'api-key' && key) env.CODEX_API_KEY = key;
    const child = spawn(binary, ['-c', `cli_auth_credentials_store="${credentialStore()}"`, 'app-server'], { cwd: temp, env, stdio: ['pipe', 'pipe', 'ignore'] });
    const stop = () => { child.kill('SIGKILL'); };
    signal.addEventListener('abort', stop, { once: true });
    try {
      return await new Promise<EngineModel[]>((resolve, reject) => {
        const models: EngineModel[] = []; let buffer = ''; let request = 1; let pages = 0;
        const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
        const list = (cursor?: string) => send({ id: ++request, method: 'model/list', params: cursor ? { cursor } : {} });
        child.once('error', () => reject(new AppError('engine_unavailable', 'The Codex runtime could not be started')));
        child.once('exit', () => reject(new AppError(signal.aborted ? 'timeout' : 'engine_failed', 'Codex stopped before it listed its models')));
        child.stdin.on('error', () => {});
        child.stdout.on('data', chunk => {
          buffer += String(chunk); if (buffer.length > 4_000_000) return reject(new AppError('engine_failed', 'Codex sent an oversized model list'));
          for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
            const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
            let message: { id?: number; error?: unknown; result?: { data?: unknown; nextCursor?: unknown } };
            try { message = JSON.parse(line); } catch { continue; }
            if (message.id === 1) { if (message.error) return reject(new AppError('engine_failed', 'Codex refused the model list session')); send({ method: 'initialized' }); list(); continue; }
            if (message.id !== request) continue; // notifications and earlier pages
            if (message.error || !Array.isArray(message.result?.data)) return reject(new AppError('engine_failed', 'Codex did not return a model list'));
            for (const m of message.result.data as { id?: unknown; model?: unknown; displayName?: unknown; hidden?: unknown }[]) if (m && !m.hidden) models.push({ id: String(m.model ?? m.id ?? ''), name: String(m.displayName ?? '') });
            const next = message.result.nextCursor;
            if (typeof next === 'string' && next && ++pages < 10) list(next); else resolve(models);
          }
        });
        send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'devagents', title: 'DevAgents', version: '0.1.0' } } });
      });
    } finally { signal.removeEventListener('abort', stop); stop(); await rm(temp, { recursive: true, force: true }); }
  };
}

type ClaudeModelQuery = (input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => { supportedModels(): Promise<{ value: string; resolvedModel?: string; displayName: string }[]> };
/**
 * The Agent SDK reports the models its bundled runtime offers this account. No prompt is sent:
 * the input stream stays empty until the list has been read. Aliases are saved as the exact
 * model they resolve to, so a member's choice stays pinned.
 */
export function claudeModelLister(dataDir: string, provider: Provider | undefined, options: { query?: ClaudeModelQuery } = {}): ModelLister {
  return async signal => {
    if (!provider) throw new AppError('provider_unknown', 'No Anthropic connection is configured for Claude');
    const credential = await claudeCredential(dataDir, provider);
    if (!credential) throw new AppError('missing_auth', 'Connect Claude in Settings before loading its models');
    const directory = await mkdtemp(join(tmpdir(), 'devagents-models-'));
    const controller = new AbortController(); const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    let release = () => {}; const hold = new Promise<void>(done => { release = done; });
    async function* input(): AsyncIterable<SDKUserMessage> { await hold; }
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.keys(process.env).map(k => [k, undefined]));
    Object.assign(env, safeEnvironment(directory, directory), { CLAUDE_CONFIG_DIR: directory, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', [credential.method === 'api-key' ? 'ANTHROPIC_API_KEY' : 'CLAUDE_CODE_OAUTH_TOKEN']: credential.value });
    try {
      const session = (options.query ?? (query as unknown as ClaudeModelQuery))({ prompt: input(), options: { cwd: directory, env, abortController: controller, settingSources: [], settings: { disableAllHooks: true }, tools: [], permissionMode: 'dontAsk', strictMcpConfig: true, persistSession: false } });
      const models = await Promise.race([session.supportedModels(), new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new AppError('timeout', 'Claude did not list its models in time')), { once: true }))]);
      return models.filter(m => m.value !== 'default').map(m => ({ id: m.resolvedModel ?? m.value, name: /^claude/i.test(m.displayName) ? m.displayName : `Claude ${m.displayName}` }));
    } catch (error) {
      if (error instanceof AppError) throw error;
      // Never pass runtime output on: it can quote account details.
      throw new AppError('engine_failed', 'Claude did not return a model list');
    } finally { abort(); release(); signal.removeEventListener('abort', abort); await rm(directory, { recursive: true, force: true }); }
  };
}

/** Saved lists per engine, replaced only by a successful load so a failure never loses the previous one. */
export class ModelCatalogService {
  private readonly loading = new Map<string, Promise<ModelCatalog>>();
  constructor(private readonly store: Store, private readonly listers: Record<string, ModelLister>, private readonly now: () => Date = () => new Date()) {}
  list(): ModelCatalog[] { return Object.keys(this.listers).flatMap(engine => this.store.modelCatalog(engine) ?? []); }
  /** One request per engine at a time; a second click joins the first. */
  refresh(engine: string): Promise<ModelCatalog> {
    const lister = this.listers[engine];
    if (!lister) throw new AppError('engine_unavailable', `Engine "${engine}" cannot list models in this build`, 404);
    let running = this.loading.get(engine);
    if (!running) {
      running = this.load(engine, lister).finally(() => this.loading.delete(engine));
      this.loading.set(engine, running);
    }
    return running;
  }
  private async load(engine: string, lister: ModelLister): Promise<ModelCatalog> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), LIST_TIMEOUT_MS);
    let models: EngineModel[];
    try { models = clean(await lister(controller.signal)); }
    catch (error) {
      const known = error instanceof AppError && ['missing_auth', 'vault_locked', 'provider_unknown'].includes(error.code);
      throw new AppError('model_list_failed', known ? (error as AppError).message : `Could not load models from ${engine}. The saved list is unchanged.`, 502);
    } finally { clearTimeout(timer); }
    if (!models.length) throw new AppError('model_list_failed', `${engine} returned no models. The saved list is unchanged.`, 502);
    const previous = this.store.modelCatalog(engine);
    const known = new Set(previous?.models.map(m => m.id));
    const catalog: ModelCatalog = { engine, models, loadedAt: this.now().toISOString(), newIds: previous ? models.filter(m => !known.has(m.id)).map(m => m.id) : [] };
    this.store.saveModelCatalog(catalog);
    return catalog;
  }
}
