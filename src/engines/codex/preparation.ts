import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { DependencyInstaller } from '../../workspace/environment.js';
import { runProcess } from '../process.js';
import { pnpmCli } from '../node-tools.js';
import { safeEnvironment, sandboxFlags, verifyCodex } from './sandbox.js';

/** The only network-enabled command sandbox. Its cwd is a fresh metadata-only workspace,
 * constructed by the environment adapter; callers cannot supply executable/argv or scripts.
 */
export class CodexDependencyInstaller implements DependencyInstaller {
  constructor(private readonly dataDir: string, private readonly binary = 'codex', private readonly options: { scanLimit?: number; timeoutMs?: number } = {}) {}
  async install(cwd: string, manager: 'npm' | 'pnpm', signal: AbortSignal) {
    const home = join(this.dataDir, 'preparation-runs', randomUUID()); const temp = join(home, 'tmp');
    await mkdir(temp, { recursive: true, mode: 0o700 });
    try {
      await verifyCodex(this.binary, home);
      const command = manager === 'pnpm'
        ? [process.execPath, pnpmCli, 'install', '--frozen-lockfile', '--ignore-scripts', '--ignore-pnpmfile', '--config.manage-package-manager-versions=false', '--config.package-import-method=copy', '--store-dir', join(temp, 'store'), '--config.side-effects-cache=false', '--config.engine-strict=true', '--config.verify-deps-before-run=false', '--reporter=append-only']
        : ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--include=dev', '--engine-strict', '--cache', join(temp, 'cache')];
      const flags = await sandboxFlags(cwd, { readPaths: ['project:/**'], writePaths: ['project:/**'], allowCommands: true, allowPush: false }, temp, this.options.scanLimit, false, true);
      const result = await runProcess(this.binary, [...flags, 'sandbox', '-C', cwd, '-P', 'devagents', '--', ...command], {
        cwd, env: { ...safeEnvironment(home, temp), CI: 'true', COREPACK_ENABLE_NETWORK: '0', npm_config_userconfig: join(temp, 'user.npmrc'), npm_config_globalconfig: join(temp, 'global.npmrc') }, signal,
        timeoutMs: this.options.timeoutMs ?? 600000, maxBytes: 1024 * 1024, overflow: 'truncate',
      });
      return { exitCode: result.exitCode, output: result.stdout + result.stderr };
    } finally { await rm(home, { recursive: true, force: true }); }
  }
}
