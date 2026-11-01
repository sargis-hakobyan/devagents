import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { dirname, join, matchesGlob, relative, resolve } from 'node:path';
import { satisfies, validRange } from 'semver';
import { parse, stringify } from 'yaml';
import { AppError } from '../domain/errors.js';
import { protectedPath } from '../domain/protected-paths.js';
import type { ValidationCommand } from '../domain/validation.js';
import { git } from './git.js';
import { isWithin, scopedPath } from './paths.js';

export type EnvironmentRequest = { cwd: string; commands: ValidationCommand[]; signal: AbortSignal; rules: boolean };
export type EnvironmentEvent = { state: 'checking' | 'installing' | 'ready' | 'failed'; message: string; manager?: string; fingerprint?: string; output?: string };
export interface EnvironmentPreparer {
  prepare(request: EnvironmentRequest, report: (event: EnvironmentEvent) => void): Promise<void>;
}
/** A trusted installer implementation, distinct from model-selected validation commands. */
export interface DependencyInstaller {
  install(cwd: string, manager: 'npm' | 'pnpm', signal: AbortSignal): Promise<{ output: string; exitCode: number }>;
}
export const PNPM_VERSION = '10.34.9';
const workspaceKeys = new Set(['packages', 'overrides', 'catalog', 'catalogs', 'patchedDependencies', 'peerDependencyRules', 'packageExtensions']);
const manifestKeys = new Set(['name', 'version', 'private', 'type', 'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'workspaces', 'engines', 'os', 'cpu', 'bin']);
const block = (message: string): never => { throw new AppError('environment_blocked', `Environment blocked: ${message}`); };
const exists = async (file: string) => lstat(file).then(() => true, () => false);

/** Restricted preparation adapter, selected by the runner only with extra rules enabled.
 * Supports root Node/npm/pnpm workspaces.
 * Network installation sees only dependency metadata and patches, never the source checkout,
 * its .npmrc, login profiles or service database. Only node_modules is copied back.
 */
export class NodeEnvironmentPreparer implements EnvironmentPreparer {
  private readonly prepared = new Map<string, { fingerprint: string; modules: boolean }>();
  constructor(private readonly dataDir: string, private readonly installer: DependencyInstaller) {}

  async prepare(request: EnvironmentRequest, report: (event: EnvironmentEvent) => void): Promise<void> {
    const { cwd, signal } = request;
    signal.throwIfAborted();
    try {
      const inputs = await this.inputs(cwd);
      if (!inputs) return; // Non-Node repositories keep their existing execution path.
      const { files, manager, manifests } = inputs;
      const fingerprint = createHash('sha256').update(process.version).update(manager).update(JSON.stringify([...files])).digest('hex');
      const previous = this.prepared.get(cwd);
      if (previous?.fingerprint === fingerprint && (!previous.modules || await exists(join(cwd, 'node_modules')))) return;
      report({ state: 'checking', manager, fingerprint, message: 'Checking runtime and locked dependency inputs' });
      const root = JSON.parse(files.get('package.json')!);
      const nodeRange = root.engines?.node;
      if (nodeRange && (typeof nodeRange !== 'string' || !validRange(nodeRange) || !satisfies(process.version, nodeRange))) {
        block(`Project requires Node ${String(nodeRange)}; DevAgents runs ${process.version}. Use a compatible DevAgents runtime before submitting again.`);
      }
      if (manager === 'pnpm' && root.packageManager && !/^pnpm@10\.\d+\.\d+(?:\+sha\d+\.[a-f0-9]+)?$/.test(root.packageManager)) {
        block(`Project declares ${root.packageManager}; this runtime supports pnpm 10 using bundled pnpm@${PNPM_VERSION}. Other major versions need a compatible environment adapter.`);
      }
      if (manager === 'pnpm' && root.engines?.pnpm && !satisfies(PNPM_VERSION, root.engines.pnpm)) block(`Bundled pnpm ${PNPM_VERSION} does not satisfy engines.pnpm.`);
      const lock = manager === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json';
      const needsInstall = manifests.some(path => {
        const m = JSON.parse(files.get(path)!);
        return ['dependencies', 'devDependencies', 'optionalDependencies'].some(key => Object.keys(m[key] ?? {}).length);
      });
      if (!needsInstall && !files.has(lock)) {
        this.prepared.set(cwd, { fingerprint, modules: false });
        report({ state: 'ready', manager, fingerprint, message: 'Runtime checked; no external Node dependencies to install' });
        return;
      }
      if (!files.has(lock)) block(`Commit ${lock} for reproducible dependency installation. DevAgents will not create or update a lockfile during setup.`);
      // External local paths and Git dependencies require a separate provider/credential contract.
      for (const path of manifests) {
        const manifest = JSON.parse(files.get(path)!);
        for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) for (const spec of Object.values(manifest[key] ?? {})) {
          if (typeof spec !== 'string' || /^(?:git[+:@]|github:|gitlab:|bitbucket:|file:|link:)/.test(spec)
            || (!validRange(spec) && !/^(?:workspace:|npm:|https?:\/\/|[a-zA-Z][\w.-]*$)/.test(spec))) {
            block(`Local-file or Git dependencies in ${path} need an explicit environment adapter; automatic setup supports registry and workspace dependencies.`);
          }
        }
      }
      const inspectLock = (value: unknown): void => {
        if (typeof value === 'string' && /^(?:git[+:@]|github:|gitlab:|bitbucket:|file:)/.test(value)) block('Local-file or Git lockfile resolutions need an explicit environment adapter');
        if (!value || typeof value !== 'object') return;
        const resolution = (value as Record<string, unknown>).resolution;
        if (resolution && typeof resolution === 'object' && ('repo' in resolution || 'commit' in resolution || ('type' in resolution && resolution.type === 'git'))) block('Git lockfile resolutions need an explicit environment adapter');
        for (const child of Object.values(value)) inspectLock(child);
      };
      inspectLock(manager === 'pnpm' ? parse(files.get(lock)!) : JSON.parse(files.get(lock)!));
      for (const path of manifests) {
        const modules = join(dirname(path), 'node_modules');
        await scopedPath(cwd, modules);
        if ((await git(cwd, ['ls-files', '--', modules])).trim()) block(`Tracked ${modules} cannot be replaced by dependency preparation.`);
        if (!(await git(cwd, ['--no-literal-pathspecs', 'check-ignore', '--no-index', '--', `${modules}/probe`]).catch(() => '')).trim()) block(`Add node_modules to the project's .gitignore before dependency preparation.`);
      }
      const parent = join(this.dataDir, 'preparation'); await mkdir(parent, { recursive: true, mode: 0o700 });
      const stage = await mkdtemp(join(parent, 'node-'));
      try {
        for (const [path, content] of files) {
          const target = await scopedPath(stage, path); await mkdir(dirname(target), { recursive: true });
          let safe = content;
          if (path.endsWith('package.json')) {
            const manifest = JSON.parse(content);
            safe = JSON.stringify(Object.fromEntries(Object.entries(manifest).filter(([key]) => manifestKeys.has(key))));
          }
          if (path === 'pnpm-workspace.yaml') {
            const config = parse(content) as Record<string, unknown>;
            safe = stringify(Object.fromEntries(Object.entries(config).filter(([key]) => workspaceKeys.has(key))));
          }
          await writeFile(target, safe, { mode: 0o600 });
        }
        report({ state: 'installing', manager, fingerprint, message: 'Installing locked dependencies without lifecycle scripts in an isolated preparation workspace' });
        const result = await this.installer.install(stage, manager, signal);
        signal.throwIfAborted();
        if (result.exitCode !== 0) block(`Dependency installation failed (exit ${result.exitCode}). ${result.output.slice(-4000)}`);
        for (const path of manifests) {
          const modules = join(dirname(path), 'node_modules');
          if (!await exists(join(stage, modules))) continue;
          await this.assertTree(stage, join(stage, modules));
          signal.throwIfAborted();
          const target = await scopedPath(cwd, modules);
          await rm(target, { recursive: true, force: true });
          await cp(join(stage, modules), target, { recursive: true, verbatimSymlinks: true });
        }
        this.prepared.set(cwd, { fingerprint, modules: true });
        report({ state: 'ready', manager, fingerprint, message: `Locked dependencies installed with ${manager === 'pnpm' ? `bundled pnpm ${PNPM_VERSION}` : 'runtime npm'}; install scripts were skipped`, output: result.output.slice(-4000) });
      } finally { await rm(stage, { recursive: true, force: true }); }
    } catch (error) {
      if (signal.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      report({ state: 'failed', message });
      if (error instanceof AppError && error.code === 'environment_blocked') throw error;
      block(message);
    }
  }

  private async inputs(cwd: string) {
    const paths = (await git(cwd, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], false, 64 * 1024 * 1024)).split('\0').filter(Boolean);
    if (!paths.includes('package.json')) return;
    const files = new Map<string, string>(); let bytes = 0;
    const read = async (path: string) => {
      if (protectedPath(path)) block('Dependency metadata points to a protected path');
      const target = await scopedPath(cwd, path); const stat = await lstat(target);
      if (!stat.isFile() || stat.nlink > 1 || stat.size > 16 * 1024 * 1024 || (bytes += stat.size) > 32 * 1024 * 1024) block('Dependency metadata exceeds the regular-file or 32 MiB input limit');
      files.set(path, await readFile(target, 'utf8'));
    };
    await read('package.json');
    for (const path of ['pnpm-lock.yaml', 'package-lock.json', 'pnpm-workspace.yaml']) if (paths.includes(path)) await read(path);
    const root = JSON.parse(files.get('package.json')!);
    const declared = typeof root.packageManager === 'string' ? root.packageManager.split('@')[0] : undefined;
    if (declared && !['npm', 'pnpm'].includes(declared)) block(`Automatic preparation for ${declared} is not implemented. Use an environment adapter for this package manager.`);
    if (!declared && files.has('pnpm-lock.yaml') && files.has('package-lock.json')) block('Multiple root lockfiles; declare packageManager explicitly');
    const manager = declared === 'pnpm' || (!declared && files.has('pnpm-lock.yaml')) ? 'pnpm' : 'npm';
    const workspace = manager === 'pnpm' && files.has('pnpm-workspace.yaml') ? parse(files.get('pnpm-workspace.yaml')!) : undefined;
    const patterns = workspace?.packages ?? root.workspaces?.packages ?? root.workspaces ?? [];
    if (!Array.isArray(patterns) || patterns.some(p => typeof p !== 'string' || p.includes('..') || p.startsWith('/'))) block('Workspace package patterns must stay inside the project');
    const manifests = [...new Set(paths.filter(p => p === 'package.json' || (p.endsWith('/package.json') && !p.split('/').includes('node_modules') && !protectedPath(p)
      && patterns.some((glob: string) => !glob.startsWith('!') && matchesGlob(dirname(p), glob))
      && !patterns.some((glob: string) => glob.startsWith('!') && matchesGlob(dirname(p), glob.slice(1))))))].sort();
    if (manifests.length > 2000) block('More than 2000 package manifests; use a dedicated environment adapter');
    for (const path of manifests) if (path !== 'package.json') await read(path);
    if (manager === 'pnpm' && files.has('pnpm-workspace.yaml')) {
      for (const path of Object.values(workspace?.patchedDependencies ?? {})) {
        if (typeof path !== 'string' || !paths.includes(path)) block('Dependency patches must be project files');
        await read(path as string);
      }
    }
    return { files, manifests, manager: manager as 'npm' | 'pnpm' };
  }

  private async assertTree(root: string, directory: string, budget = { count: 0 }): Promise<void> {
    const directoryInfo = await lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) block('Installed node_modules must be a real directory');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++budget.count > 500000) block('Installed dependencies exceed 500000 entries');
      const path = join(directory, entry.name); const stat = await lstat(path);
      if (entry.isSymbolicLink()) {
        const target = await readlink(path);
        if (target.startsWith('/') || !isWithin(root, resolve(dirname(path), target)) || protectedPath(relative(root, resolve(dirname(path), target)))) block('Installed dependency contains an unsafe symlink');
      } else if (entry.isDirectory()) await this.assertTree(root, path, budget);
      else if (!entry.isFile() || stat.nlink > 1) block('Installed dependency contains a special file or hardlink');
    }
  }
}
