import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { configuredVault } from '../../security/credential-vault.js';
import { AppError } from '../../domain/errors.js';
import type { Provider } from '../../domain/schemas.js';
export type ClaudeCredential = { method: 'api-key' | 'subscription'; value: string };
export async function claudeCredential(dataDir: string, provider?: Provider): Promise<ClaudeCredential | undefined> {
  if (provider?.apiKeyEnv && process.env[provider.apiKeyEnv]) return { method: 'api-key', value: process.env[provider.apiKeyEnv]! };
  if (provider?.auth === 'api-key') throw new AppError('missing_auth', 'Set the configured Anthropic API key environment variable');
  const vault = await configuredVault(dataDir, 'claude');
  if (!vault) return process.env.ANTHROPIC_API_KEY ? { method: 'api-key', value: process.env.ANTHROPIC_API_KEY } : process.env.CLAUDE_CODE_OAUTH_TOKEN ? { method: 'subscription', value: process.env.CLAUDE_CODE_OAUTH_TOKEN } : undefined;
  await vault.assertUnlocked();
  try {
    const saved: unknown = JSON.parse(await readFile(vault.auth, 'utf8'));
    if (saved && typeof saved === 'object' && 'method' in saved && ['api-key', 'subscription'].includes(String(saved.method)) && 'value' in saved && typeof saved.value === 'string' && saved.value) return saved as ClaudeCredential;
    throw new Error('Invalid credential');
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw new AppError('invalid_credentials', 'Claude credentials could not be read'); }
}
export async function saveClaudeCredential(dataDir: string, method: ClaudeCredential['method'], value: string): Promise<void> {
  if (!value || /\s/.test(value)) throw new AppError('invalid_key', 'Expected one credential without whitespace');
  const vault = await configuredVault(dataDir, 'claude');
  if (!vault) throw new AppError('vault_unconfigured', 'Use the Docker launcher to save Claude credentials securely, or set ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN for the native service');
  await vault.assertUnlocked();
  await mkdir(dirname(vault.auth), { recursive: true, mode: 0o700 });
  const temp = `${vault.auth}.${randomUUID()}.tmp`;
  try { await writeFile(temp, JSON.stringify({ method, value }), { mode: 0o600, flag: 'wx' }); await rename(temp, vault.auth); await vault.seal(); }
  finally { await rm(temp, { force: true }); }
}
