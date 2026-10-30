import { engineHealth } from '../engines/health.js';
import { configuredVault, credentialStore } from '../security/credential-vault.js';
import type { AppConfig } from '../domain/schemas.js';

export type ServiceStatus = {
  service: { version: string; host: string; port: number; platform: string; node: string; dataDir: string; executionEnabled: boolean; startedAt: string; checkedAt: string };
  codex: { installed: boolean; version?: string; signedIn: boolean; credentialStore: 'keyring' | 'file'; vaultLocked: boolean; modelAccessVerified: false };
  claude: { installed: boolean; version?: string; enabled: false; note: string };
  defaults: { engine: string; provider: string; model: string | null; providers: { id: string; kind: string; auth: string; apiKeyConfigured: boolean | null; executable: boolean }[] };
  limits: { concurrency: number; maxRepairCycles: number; executionTimeoutMs: number; validationTimeoutMs: number; workspaceScanLimit: number };
};
/**
 * Secret-free availability report for the Settings and Overview screens. It never includes key
 * values, tokens or raw runtime output, and it never contacts a model: a saved sign-in is reported
 * as such, with model access explicitly unverified. Cached because it runs `codex login status`.
 */
export function statusReporter(input: { dataDir: string; config: AppConfig; version: string; host: string; port: () => number; executionEnabled: boolean; ttlMs?: number }): () => Promise<ServiceStatus> {
  const startedAt = new Date().toISOString(); let cached: { at: number; value: ServiceStatus } | undefined;
  return async () => {
    if (cached && Date.now() - cached.at < (input.ttlMs ?? 30000)) return cached.value;
    const health = await engineHealth(input.dataDir);
    const codex = health.engines.find(e => e.id === 'codex'); const claude = health.engines.find(e => e.id === 'claude-code');
    const vault = await configuredVault(input.dataDir).catch(() => undefined);
    const vaultLocked = vault ? await vault.assertUnlocked().then(() => false, () => true) : false;
    const value: ServiceStatus = {
      service: { version: input.version, host: input.host, port: input.port(), platform: `${process.platform}/${process.arch}`, node: process.version, dataDir: input.dataDir, executionEnabled: input.executionEnabled, startedAt, checkedAt: new Date().toISOString() },
      codex: { installed: Boolean(codex?.installed), ...(codex?.version ? { version: codex.version } : {}), signedIn: health.codexAuthenticated && !vaultLocked, credentialStore: credentialStore(), vaultLocked, modelAccessVerified: false },
      claude: { installed: Boolean(claude?.installed), ...(claude?.version ? { version: claude.version } : {}), enabled: false, note: 'Adapter planned for M4; not available for execution' },
      defaults: {
        engine: input.config.defaultEngine, provider: input.config.defaultProvider, model: input.config.defaultModel ?? null,
        providers: input.config.providers.map(p => ({ id: p.id, kind: p.kind, auth: p.auth, apiKeyConfigured: p.apiKeyEnv ? Boolean(process.env[p.apiKeyEnv]) : null, executable: p.kind === 'openai' && !p.baseUrl })),
      },
      limits: { concurrency: input.config.concurrency, maxRepairCycles: input.config.maxRepairCycles, executionTimeoutMs: input.config.executionTimeoutMs, validationTimeoutMs: input.config.validationTimeoutMs, workspaceScanLimit: input.config.workspaceScanLimit },
    };
    cached = { at: Date.now(), value };
    return value;
  };
}
