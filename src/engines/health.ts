import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { runtimeHome } from './codex/sandbox.js';
import { credentialStore } from '../security/credential-vault.js';

const exec = promisify(execFile);
export async function engineHealth(dataDir: string) {
  const results = [];
  for (const [id, binary] of [['codex', 'codex'], ['claude-code', 'claude']] as const) {
    try {
      const { stdout } = await exec(binary, ['--version'], { timeout: 5000 });
      results.push({ id, installed: true, version: stdout.trim(), execution: id === 'codex' ? 'available-after-auth' : 'not-implemented' });
    } catch { results.push({ id, installed: false, execution: 'not-enabled' }); }
  }
  const home = runtimeHome(dataDir);
  await mkdir(home, { recursive: true, mode: 0o700 });
  let codexAuthenticated = false;
  try {
    await exec('codex', ['-c', `cli_auth_credentials_store="${credentialStore()}"`, 'login', 'status'], { timeout: 5000, env: { PATH: process.env.PATH, HOME: credentialStore() === 'keyring' ? homedir() : home, CODEX_HOME: home } });
    codexAuthenticated = true;
  } catch { /* Missing authentication is a setup condition, not a crash. */ }
  return { engines: results, codexAuthenticated, codexHome: home };
}
