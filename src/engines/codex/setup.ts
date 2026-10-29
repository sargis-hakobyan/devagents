import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runProcess } from '../process.js';
import { runtimeHome, safeEnvironment } from './sandbox.js';
import { readHiddenKey } from '../../cli/secret-prompt.js';
import { AppError } from '../../domain/errors.js';

export async function setupCodexAuth(dataDir: string, options: {
  replaceKey?: boolean; binary?: string; readKey?: () => Promise<string>;
} = {}): Promise<'saved' | 'reused'> {
  const home = runtimeHome(dataDir);
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  const binary = options.binary ?? 'codex';
  const config = ['-c', 'cli_auth_credentials_store="file"'];
  const processOptions = { cwd: home, env: safeEnvironment(home, home), timeoutMs: 15000 };
  if (!options.replaceKey) {
    const status = await runProcess(binary, [...config, 'login', 'status'], processOptions);
    if (status.exitCode === 0) {
      await chmod(join(home, 'auth.json'), 0o600);
      return 'reused';
    }
  }
  const key = await (options.readKey ?? readHiddenKey)();
  if (!key || /\s/.test(key)) throw new AppError('invalid_key', 'Expected one non-empty API key');
  // Pass the key on stdin only: never through process arguments, logs or Compose env.
  const result = await runProcess(binary, [...config, 'login', '--with-api-key'], { ...processOptions, input: `${key}\n` });
  if (result.exitCode !== 0) throw new AppError('login_failed', 'Codex could not save the API key. Run setup again.');
  await chmod(join(home, 'auth.json'), 0o600);
  return 'saved';
}
