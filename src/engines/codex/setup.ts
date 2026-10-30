import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { runProcess } from '../process.js';
import { runtimeHome, safeEnvironment } from './sandbox.js';
import { readHiddenKey } from '../../cli/secret-prompt.js';
import { AppError } from '../../domain/errors.js';
import { configuredVault, credentialStore } from '../../security/credential-vault.js';

export async function setupCodexAuth(dataDir: string, options: {
  replaceKey?: boolean; binary?: string; readKey?: () => Promise<string>; store?: 'file' | 'keyring';
} = {}): Promise<'saved' | 'reused'> {
  const vault = await configuredVault(dataDir); await vault?.assertUnlocked();
  const home = runtimeHome(dataDir);
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  const binary = options.binary ?? 'codex';
  const store = options.store ?? credentialStore();
  const config = ['-c', `cli_auth_credentials_store="${store}"`];
  const env = safeEnvironment(home, home);
  if (store === 'keyring') env.HOME = homedir();
  const processOptions = { cwd: home, env, timeoutMs: 15000 };
  if (!options.replaceKey) {
    const status = await runProcess(binary, [...config, 'login', 'status'], processOptions);
    if (status.exitCode === 0) {
      if (store === 'file') await chmod(join(home, 'auth.json'), 0o600);
      await vault?.seal();
      return 'reused';
    }
  }
  const key = await (options.readKey ?? readHiddenKey)();
  if (!key || /\s/.test(key)) throw new AppError('invalid_key', 'Expected one non-empty API key');
  // Pass the key on stdin only: never through process arguments, logs or Compose env.
  const result = await runProcess(binary, [...config, 'login', '--with-api-key'], { ...processOptions, input: `${key}\n` });
  if (result.exitCode !== 0) throw new AppError('login_failed', 'Codex could not save the API key. Run setup again.');
  if (store === 'file') await chmod(join(home, 'auth.json'), 0o600);
  await vault?.seal();
  return 'saved';
}

/** Interpret status only; never forward runtime output, which may include key fragments. */
export async function codexAuthStatus(dataDir: string, options: { binary?: string; store?: 'file' | 'keyring' } = {}): Promise<import('../../domain/auth.js').AuthStatus> {
  await (await configuredVault(dataDir))?.assertUnlocked();
  const home = runtimeHome(dataDir); await mkdir(home, { recursive: true, mode: 0o700 });
  const store = options.store ?? credentialStore(); const env = safeEnvironment(home, home);
  if (store === 'keyring') env.HOME = homedir();
  const result = await runProcess(options.binary ?? 'codex', ['-c', `cli_auth_credentials_store="${store}"`, 'login', 'status'], { cwd: home, env, timeoutMs: 15000 });
  if (result.exitCode !== 0) return { saved: false };
  const text = `${result.stdout}\n${result.stderr}`;
  return { saved: true, method: /using an? API key/i.test(text) ? 'api-key' : /using ChatGPT/i.test(text) ? 'chatgpt' : 'unknown' };
}
