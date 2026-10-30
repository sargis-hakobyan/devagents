#!/usr/bin/env node
import { Command, Option } from 'commander';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { loadConfig, dataDirectory } from '../config.js';
import { Store } from '../persistence/store.js';
import { TaskService } from '../orchestration/service.js';
import { createApi, accessToken } from '../api/server.js';
import { BrowserSessions } from '../api/session.js';
import { findUiRoot } from '../api/static.js';
import { statusReporter } from '../api/status.js';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineHealth } from '../engines/health.js';
import { environmentSecrets, log, redactValues } from '../telemetry/redact.js';
import { AppError } from '../domain/errors.js';
import { CodexAdapter } from '../engines/codex/adapter.js';
import { CodexValidator } from '../engines/codex/validator.js';
import { TaskRunner } from '../orchestration/runner.js';
import { lockService } from '../persistence/service-lock.js';
import { setupCodexAuth, codexAuthStatus } from '../engines/codex/setup.js';
import { loginWithChatGPT } from '../engines/codex/device-login.js';
import { testCodexConnection } from '../engines/codex/connection-test.js';
import { onboard } from './onboarding.js';
import type { AuthChoice } from '../domain/auth.js';
import { readChoice } from './choice-prompt.js';
import { configuredVault } from '../security/credential-vault.js';

const print = (data: unknown) => console.log(JSON.stringify(redactValues(data, environmentSecrets()), null, 2));
const port = () => z.coerce.number().int().min(1).max(65535).parse(process.env.DEVAGENTS_PORT ?? 4310);
async function request(path: string, method = 'GET', body?: unknown, key?: string): Promise<unknown> {
  const token = (await readFile(join(dataDirectory(), 'api-token'), 'utf8')).trim();
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  if (key) headers['idempotency-key'] = key;
  const res = await fetch(`http://127.0.0.1:${port()}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
  const result = await res.json();
  if (!res.ok) throw new AppError('api_error', JSON.stringify(result), res.status);
  return result;
}
const cli = new Command().name('devagents').description('Local-first configurable development teams').version('0.1.0');
cli.command('serve').description('Start the local API').action(async () => {
  const dataDir = dataDirectory(); const config = await loadConfig();
  const unlock = lockService(dataDir);
  const configuredSecrets = config.providers.flatMap(p => p.apiKeyEnv && process.env[p.apiKeyEnv] ? [process.env[p.apiKeyEnv]!] : []);
  const store = new Store(join(dataDir, 'devagents.db'), [...environmentSecrets(), ...configuredSecrets]);
  const service = new TaskService(store, config, dataDir);
  const sandbox = { scanLimit: config.workspaceScanLimit };
  const runner = new TaskRunner(service, new CodexAdapter(dataDir, 'codex', sandbox), new CodexValidator(dataDir, 'codex', sandbox));
  service.attachRunner(runner);
  // Docker explicitly binds to all container interfaces; Compose exposes only host loopback.
  const host = process.env.DEVAGENTS_HOST ?? '127.0.0.1';
  if (!['127.0.0.1', '0.0.0.0'].includes(host)) throw new AppError('invalid_host', 'Unsupported bind address');
  const here = dirname(fileURLToPath(import.meta.url));
  const uiRoot = await findUiRoot([resolve(here, '../ui'), resolve(here, '../../dist/ui'), resolve(here, '../../ui/dist')]);
  const server = createApi(service, await accessToken(dataDir), {
    sessions: new BrowserSessions(), uiRoot,
    status: statusReporter({ dataDir, config, version: '0.1.0', host, port: port, executionEnabled: true }),
  });
  await service.agents();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port(), host, resolve); });
  // Only the process which owns the listening socket may reconcile this service's tasks.
  const recovered = store.recover();
  log('service_started', { host, port: port(), recovered, projects: store.projects().length, executionEnabled: true, ui: uiRoot ? `http://127.0.0.1:${port()}/ui/` : 'not built' });
  log('setup', { message: 'Register an existing checkout and authenticate Codex. Use tasks submit, show and evidence to follow work. Open the browser UI with a one-time link from: devagents ui' });
  let closing = false;
  const shutdown = () => {
    if (closing) return; closing = true;
    void runner.stop();
    server.close(() => { void runner.stop().then(() => { store.close(); unlock(); process.exitCode = 0; }); });
    server.closeIdleConnections();
  };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
});
cli.command('ui').description('Create a one-time sign-in link for the browser UI (never exposes the CLI token)').option('--open', 'Open the link with the OS browser').action(async (opts: { open?: boolean }) => {
  const link = await request('/ui/bootstrap', 'POST', {}) as { url: string; expiresInSeconds: number };
  console.log(link.url);
  console.error(`Single use, valid for ${Math.round(link.expiresInSeconds / 60)} minutes. Sessions end when the service restarts.`);
  if (!opts.open) return;
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  const child = spawn(opener, [link.url], { stdio: 'ignore', detached: true });
  child.once('error', () => console.error('Could not open a browser automatically; open the link above manually.'));
  child.unref();
});
cli.command('doctor').description('Report configuration and engine setup').action(async () => {
  const config = await loadConfig();
  const health = await engineHealth(dataDirectory());
  print({ node: process.version, platform: `${process.platform}/${process.arch}`, ...health, providers: config.providers.map(p => ({ id: p.id, kind: p.kind, auth: p.auth, apiKeyConfigured: p.apiKeyEnv ? Boolean(process.env[p.apiKeyEnv]) : null, localExecution: ['ollama', 'openai-compatible'].includes(p.kind) ? 'planned-follow-up' : undefined })), next: 'Start with npm run dev; register a project with npm run cli -- projects add <id> <absolute-path>' });
});
const projects = cli.command('projects');
projects.command('list').action(async () => print(await request('/projects')));
projects.command('add <id> <path>').option('--mode <mode>', 'Optional project autonomy default').action(async (id: string, path: string, opts: { mode?: string }) => print(await request('/projects', 'POST', { id, path, ...(opts.mode ? { defaultMode: opts.mode } : {}) })));
cli.command('agents').option('--project <id>').action(async (opts: { project?: string }) => print(await request(`/agents${opts.project ? `?projectId=${encodeURIComponent(opts.project)}` : ''}`)));
const tasks = cli.command('tasks');
tasks.command('list').description('Summaries of all tasks; use tasks show for the full record').action(async () => print(await request('/tasks')));
tasks.command('submit <project> <request>').option('--mode <mode>').option('--key <key>', 'Retry key; reuse it to avoid duplicate submissions').action(async (projectId: string, text: string, opts: { mode?: string; key?: string }) => {
  const task = await request('/tasks', 'POST', { projectId, request: text, ...(opts.mode ? { mode: opts.mode } : {}) }, opts.key ?? randomUUID());
  print(task);
  if ((task as { state: string }).state === 'awaiting_mode') console.error('Choose a mode: devagents tasks mode <task-id> autonomous|plan-approval');
});
tasks.command('show <id>').action(async (id: string) => print(await request(`/tasks/${id}`)));
tasks.command('events <id>').action(async (id: string) => print(await request(`/tasks/${id}/events`)));
tasks.command('evidence <id>').action(async (id: string) => print(await request(`/tasks/${id}/evidence`)));
tasks.command('items <id>').description('Show work-item progress, branches and dependency state').action(async (id: string) => print(await request(`/tasks/${id}/items`)));
tasks.command('run <id>').description('Continue an idle planning/ready checkpoint after restart').action(async (id: string) => print(await request(`/tasks/${id}/run`, 'POST', {})));
tasks.command('mode <id> <mode>').action(async (id: string, mode: string) => print(await request(`/tasks/${id}/mode`, 'POST', { mode })));
tasks.command('plan <id> <file>').description('Store a validated plan from YAML or JSON (manual M1 checkpoint)').action(async (id: string, file: string) => print(await request(`/tasks/${id}/plan`, 'POST', parse(await readFile(file, 'utf8')))));
tasks.command('approve <id>').requiredOption('--version <version>', 'Version of the plan you reviewed').action(async (id: string, opts: { version: string }) => print(await request(`/tasks/${id}/approve`, 'POST', { version: Number(opts.version) })));
tasks.command('cancel <id>').action(async (id: string) => print(await request(`/tasks/${id}/cancel`, 'POST', {})));
tasks.command('cleanup <id>').description('Remove a finished task’s managed worktrees and item branches (keeps a completed task’s branch)').action(async (id: string) => print(await request(`/tasks/${id}/cleanup`, 'POST', {})));
const auth = cli.command('auth');
auth.command('vault-exists').description('Report whether encrypted credentials exist').action(async () => {
  const vault = await configuredVault(dataDirectory());
  if (!vault) throw new AppError('vault_unconfigured', 'Use the Compose launcher for encrypted container storage');
  console.log(await vault.exists() ? 'yes' : 'no');
});
auth.command('unlock').description('Unlock the memory-backed runtime using a key from stdin').action(async () => {
  const vault = await configuredVault(dataDirectory());
  if (!vault) throw new AppError('vault_unconfigured', 'Use the Compose launcher for encrypted container storage');
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk.toString();
    if (input.length > 128) throw new AppError('invalid_master_key', 'Invalid OS credential-store input');
  }
  await vault.unlock(input.trim());
  console.log('Encrypted credential vault unlocked.');
});
auth.command('setup').description('Choose ChatGPT, an API key, or a saved login; optionally test model access')
  .addOption(new Option('--auth <method>', 'Sign-in method').choices(['chatgpt', 'api-key', 'saved']))
  .option('--test-connection', 'Send a small model request using your selected allowance or API credits')
  .option('--replace-key', 'Prompt for a replacement API key even if already signed in')
  .action(async (opts: { replaceKey?: boolean; auth?: AuthChoice; testConnection?: boolean }) => {
    if (opts.replaceKey && opts.auth && opts.auth !== 'api-key') throw new AppError('invalid_options', '--replace-key cannot be combined with another sign-in method');
    try {
      const dataDir = dataDirectory();
      const passed = await onboard({
        status: () => codexAuthStatus(dataDir),
        login: async method => {
          if (method === 'chatgpt') await loginWithChatGPT(dataDir);
          else await setupCodexAuth(dataDir, { replaceKey: true });
        },
        test: method => testCodexConnection(dataDir, method),
      }, { interactive: Boolean(process.stdin.isTTY), write: message => console.log(message), ask: readChoice }, {
        ...((opts.replaceKey || opts.auth) ? { auth: opts.replaceKey ? 'api-key' : opts.auth! } : {}),
        ...(opts.testConnection ? { testConnection: true } : {}),
      });
      if (!passed) process.exitCode = 1;
    } catch (error) {
      console.error(error instanceof AppError ? error.message : 'Setup could not finish. Check Docker and your OS credential store, then run ./devagents start again.');
      process.exitCode = 1;
    }
  });
auth.command('codex').description('Sign in to DevAgents’ dedicated Codex profile').option('--api-key-env <name>', 'Read an API key from this environment variable').action(async (opts: { apiKeyEnv?: string }) => {
  if (!opts.apiKeyEnv) { await loginWithChatGPT(dataDirectory()); return; }
  const key = process.env[opts.apiKeyEnv];
  if (!key) throw new AppError('missing_key', 'The selected API key environment variable is empty');
  await setupCodexAuth(dataDirectory(), { replaceKey: true, readKey: async () => key });
  console.log('API key saved securely. Model access has not been checked.');
});
try { await cli.parseAsync(); }
catch (error) { log('error', { message: error instanceof Error ? error.message : String(error) }); process.exitCode = 1; }
