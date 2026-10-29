import { mkdir, realpath, readdir, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { AgentDefinition } from '../../domain/schemas.js';
import { AppError } from '../../domain/errors.js';
import { assertSupportedWriteGrant } from '../../domain/ownership.js';
import { deniedSegments, protectedPath } from '../../domain/protected-paths.js';
import { runProcess } from '../process.js';
import { credentialRuntime } from '../../security/credential-vault.js';

export const CODEX_VERSION = '0.160.1';
export { deniedSegments, protectedPath };
export function toml(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) return `{${Object.entries(value).map(([k,v]) => `${JSON.stringify(k)}=${toml(v)}`).join(',')}}`;
  if (Array.isArray(value)) return `[${value.map(toml).join(',')}]`;
  return JSON.stringify(value);
}
const flags = (config: Record<string, unknown>) => Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${toml(value)}`]);
export const DEFAULT_SCAN_LIMIT = 200000;
export async function sandboxFlags(cwd: string, permissions: AgentDefinition['permissions'], temp: string, scanLimit = DEFAULT_SCAN_LIMIT): Promise<string[]> {
  const root = await realpath(cwd);
  const filesystem: Record<string, string> = { ':minimal': 'read' };
  const config: Record<string, unknown> = {
    default_permissions: 'devagents',
    permissions: { devagents: { filesystem, network: { enabled: false } } },
    approval_policy: 'never',
    projects: { [root]: { trust_level: 'untrusted' } },
  };
  for (const [paths, access] of [[permissions.readPaths, 'read'], [permissions.writePaths, 'write']] as const) {
    for (const pattern of paths) {
      const scoped = pattern.slice('project:/'.length);
      const relative = scoped === '**' ? '' : scoped.endsWith('/**') ? scoped.slice(0, -3) : scoped;
      if (/[?*\[\]{}]/.test(relative) || relative.split('/').includes('..') || relative.startsWith('/') || relative.includes('\\')) throw new AppError('unsupported_policy', 'Codex supports exact paths and subtree /** permissions only');
      if (access === 'write') assertSupportedWriteGrant(pattern, process.platform);
      filesystem[join(root, relative)] = access;
    }
  }
  // Explicit denies are enumerated freshly before each run (never cached: a stale scan could miss a
  // link created since); fixed sensitive directories remain denied. Protected names, symlinks and
  // hardlinks are each denied. A directory whose every entry is denied is denied as a whole instead
  // of entry by entry: strictly stricter (its listing is hidden too) and it keeps the generated
  // profile small for trees such as node_modules/.bin or hardlinked package stores.
  const denied = new Set(deniedSegments.map(segment => join(root, segment)));
  let count = 0;
  const scan = async (dir: string): Promise<string[]> => {
    const entries = await readdir(dir, { withFileTypes: true });
    const denies: string[] = []; let everyEntryDenied = entries.length > 0;
    for (const entry of entries) {
      if (++count > scanLimit) throw new AppError('workspace_limit', `Workspace exceeds the safety scan limit of ${scanLimit} entries; remove unneeded files from the worktree or raise workspaceScanLimit in the DevAgents configuration`);
      const path = join(dir, entry.name);
      if (protectedPath(entry.name) || entry.isSymbolicLink() || (entry.isFile() && (await lstat(path)).nlink > 1)) { denies.push(path); continue; }
      if (entry.isDirectory()) {
        const inner = await scan(path);
        if (inner.length === 1 && inner[0] === path) { denies.push(path); continue; }
        denies.push(...inner);
      }
      everyEntryDenied = false;
    }
    return everyEntryDenied && dir !== root ? [dir] : denies;
  };
  for (const path of await scan(root)) denied.add(path);
  for (const path of denied) {
    // Linux bubblewrap cannot mask a nonexistent file as a directory. Existing entries
    // are protected; creation of new runtime/secret paths is also checked before commit.
    if (await lstat(path).then(() => true, () => false)) filesystem[path] = 'deny';
  }
  await mkdir(temp, { recursive: true, mode: 0o700 });
  filesystem[await realpath(temp)] = 'write';
  const credentials = credentialRuntime();
  if (credentials) filesystem[await realpath(credentials)] = 'deny';
  // Node may live under nvm on native installations, outside :minimal.
  filesystem[dirname(await realpath(process.execPath))] = 'read';
  const npmRuntime = join(dirname(dirname(await realpath(process.execPath))), 'lib', 'node_modules', 'npm');
  if (await lstat(npmRuntime).then(() => true, () => false)) filesystem[npmRuntime] = 'read';
  return flags(config);
}
export function safeEnvironment(home: string, temp: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: temp, CODEX_HOME: home, TMPDIR: temp, LANG: 'C.UTF-8', OPENSSL_CONF: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
}
export async function verifyCodex(binary: string, home: string): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const result = await runProcess(binary, ['--version'], { cwd: home, env: safeEnvironment(home, home), timeoutMs: 5000 });
  if (result.exitCode !== 0 || result.stdout.trim() !== `codex-cli ${CODEX_VERSION}`) throw new AppError('engine_version', `This adapter requires Codex CLI ${CODEX_VERSION}; run doctor`);
}
export const runtimeHome = (dataDir: string) => credentialRuntime()
  ? resolve(credentialRuntime()!, 'codex') : resolve(dataDir, 'engines', 'codex');
