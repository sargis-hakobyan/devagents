import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { CodingEngine, EngineProgress, EngineRequest, EngineResult } from '../../domain/engine.js';
import type { AppConfig } from '../../domain/schemas.js';
import { AppError } from '../../domain/errors.js';
import { runProcess } from '../process.js';
import { runtimeHome, safeEnvironment, sandboxFlags, verifyCodex } from './sandbox.js';
import { environmentSecrets, redact, redactValues } from '../../telemetry/redact.js';
import { configuredVault, credentialStore } from '../../security/credential-vault.js';

const disabled = ['apps', 'browser_use', 'browser_use_external', 'computer_use', 'code_mode', 'hooks', 'image_generation', 'multi_agent', 'multi_agent_v2', 'plugins', 'remote_plugin', 'memories', 'skill_search', 'skill_mcp_dependency_install', 'shell_snapshot', 'view_image', 'workspace_dependencies', 'goals', 'tool_suggest'];
export class CodexAdapter implements CodingEngine {
  readonly id = 'codex';
  constructor(private readonly dataDir: string, private readonly binary = 'codex', private readonly options: { scanLimit?: number } = {}) { this.dataDir = resolve(dataDir); }
  async preflight(provider: AppConfig['providers'][number]): Promise<void> {
    await (await configuredVault(this.dataDir))?.assertUnlocked();
    if (provider.kind !== 'openai' || provider.baseUrl) throw new AppError('unsupported_provider', 'Codex supports the official OpenAI provider; other providers follow later');
    const home = runtimeHome(this.dataDir); await verifyCodex(this.binary, home);
    if (provider.auth === 'api-key') {
      if (!provider.apiKeyEnv || !process.env[provider.apiKeyEnv]) throw new AppError('missing_auth', 'Set the configured API key environment variable for the service');
    } else {
      const env = safeEnvironment(home, home);
      if (credentialStore() === 'keyring') env.HOME = homedir();
      const status = await runProcess(this.binary, ['-c', `cli_auth_credentials_store="${credentialStore()}"`, 'login', 'status'], { cwd: home, env, timeoutMs: 5000 });
      if (status.exitCode !== 0) throw new AppError('missing_auth', 'Authenticate the dedicated profile with: devagents auth codex');
    }
  }
  async execute(request: EngineRequest, progress: (event: EngineProgress) => void): Promise<EngineResult> {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(request.runId)) throw new AppError('invalid_run', 'Invalid execution run identifier');
    await this.preflight(request.provider);
    const home = runtimeHome(this.dataDir);
    const directory = join(this.dataDir, 'runs', request.runId);
    const temp = join(directory, 'tmp'); await mkdir(temp, { recursive: true, mode: 0o700 });
    const schema = join(directory, 'output.schema.json');
    await writeFile(schema, JSON.stringify(request.schema), { mode: 0o600 });
    const permissions = request.phase === 'implementation' ? request.agent.permissions : { ...request.agent.permissions, writePaths: [] };
    const args = [
      'exec',
      '-c', `cli_auth_credentials_store="${credentialStore()}"`,
      ...await sandboxFlags(request.cwd, permissions, temp, this.options.scanLimit),
      '-c', 'agents.enabled=false', '-c', 'agents.max_depth=0',
      '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0',
      '-c', 'shell_environment_policy.inherit="none"',
      '-c', `shell_environment_policy.set={PATH=${JSON.stringify(process.env.PATH ?? '')},HOME=${JSON.stringify(temp)},TMPDIR=${JSON.stringify(temp)},OPENSSL_CONF="/dev/null"}`,
      '-c', 'allow_login_shell=false', '-c', 'features.skip_host_skill_discovery=true',
      ...disabled.flatMap(flag => ['-c', `features.${flag}=false`]),
      '-c', `features.shell_tool=${permissions.allowCommands}`,
      '--ignore-user-config', '--ignore-rules', '--ephemeral', '--strict-config', '--json', '--color', 'never',
      '--skip-git-repo-check', '--cd', request.cwd, '--output-schema', schema,
      ...(request.agent.model === 'default' ? [] : ['--model', request.agent.model]), '-'
    ];
    const env = safeEnvironment(home, temp);
    if (credentialStore() === 'keyring') env.HOME = homedir();
    const key = request.provider.apiKeyEnv ? process.env[request.provider.apiKeyEnv] : undefined;
    if (request.provider.auth === 'api-key' && key) env.CODEX_API_KEY = key;
    const secrets = [...environmentSecrets(), ...(key ? [key] : [])];
    let final = ''; let completed = false; let failed = false; let failureText = ''; let usage: unknown;
    try {
      const result = await runProcess(this.binary, args, {
        // Model input gets value-only redaction so code such as `token: string` survives intact.
        cwd: request.cwd, env, input: String(redactValues(request.prompt, secrets)), signal: request.signal, timeoutMs: request.timeoutMs,
        onLine(line) {
          let event: Record<string, unknown>;
          try { event = JSON.parse(line) as Record<string, unknown>; }
          catch { throw new AppError('malformed_output', 'Codex returned malformed JSONL'); }
          if (event.type === 'turn.completed') { completed = true; usage = event.usage; progress({ kind: 'usage', data: event.usage }); }
          if (event.type === 'turn.failed' || event.type === 'error') { failed = true; failureText = JSON.stringify(redact(event.error ?? event.message ?? event, secrets)).slice(0, 2000); }
          if (event.type === 'thread.started') progress({ kind: 'started' });
          const item = event.item as Record<string, unknown> | undefined;
          if (event.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') { final = item.text; progress({ kind: 'message', text: String(redact(item.text, secrets)) }); }
          if (event.type === 'item.completed' && item?.type === 'command_execution') progress({ kind: 'command', data: redact(item, secrets) });
          if (event.type === 'item.completed' && item?.type === 'file_change') progress({ kind: 'file-change', data: redact(item, secrets) });
        }
      });
      if (result.exitCode !== 0 || failed || !completed) throw new AppError('engine_failed', `Codex did not complete successfully (exit ${result.exitCode}). ${failureText} ${String(redact(result.stderr, secrets)).slice(-2000)}`);
      try { return { output: JSON.parse(final), ...(usage ? { usage } : {}) }; }
      catch { throw new AppError('malformed_output', 'Codex did not return structured final output'); }
    } finally {
      await rm(schema, { force: true });
      // Preserve refreshed ChatGPT tokens without persisting the decrypted runtime.
      await (await configuredVault(this.dataDir))?.seal();
    }
  }
}
