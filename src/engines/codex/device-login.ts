import { spawn } from 'node:child_process';
import { mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { AppError } from '../../domain/errors.js';
import { configuredVault, credentialStore } from '../../security/credential-vault.js';
import { runtimeHome, safeEnvironment } from './sandbox.js';

export async function loginWithChatGPT(dataDir: string, options: { binary?: string; store?: 'file' | 'keyring'; signal?: AbortSignal } = {}): Promise<void> {
  if (options.signal?.aborted) throw new AppError('cancelled', 'ChatGPT sign-in cancelled.');
  const vault = await configuredVault(dataDir); await vault?.assertUnlocked();
  const home = runtimeHome(dataDir); await mkdir(home, { recursive: true, mode: 0o700 });
  const store = options.store ?? credentialStore(); const env = safeEnvironment(home, home);
  if (store === 'keyring') env.HOME = homedir();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(options.binary ?? 'codex', ['-c', `cli_auth_credentials_store="${store}"`, 'login', '--device-auth'], { cwd: home, env, stdio: 'inherit' });
    let cancelled = false; let unavailable = false; let escalation: NodeJS.Timeout | undefined;
    const cancel = () => {
      if (cancelled) return; cancelled = true; child.kill('SIGTERM');
      escalation = setTimeout(() => child.kill('SIGKILL'), 500);
    };
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    let expired = false;
    const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, 10 * 60 * 1000);
    child.once('error', () => { unavailable = true; });
    child.once('close', code => {
      clearTimeout(timer); process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
      if (escalation) clearTimeout(escalation);
      options.signal?.removeEventListener('abort', cancel);
      if (cancelled) reject(new AppError('cancelled', 'ChatGPT sign-in cancelled. Run ./devagents start to continue.'));
      else if (unavailable) reject(new AppError('engine_unavailable', 'Could not start Codex. Rebuild with ./devagents start, or check your native Codex installation.'));
      else if (code === 0 && !expired) resolve();
      else reject(new AppError('login_failed', 'ChatGPT sign-in did not complete. Enable device code sign-in in ChatGPT Settings > Security, then run ./devagents start --auth chatgpt to try again. Managed workspaces may require administrator approval.'));
    });
  });
  if (store === 'file') await chmod(join(home, 'auth.json'), 0o600);
  await vault?.seal();
}
