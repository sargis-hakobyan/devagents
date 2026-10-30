import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CodingEngine } from '../../domain/engine.js';
import { Agent } from '../../domain/schemas.js';
import { AppError } from '../../domain/errors.js';
import type { AuthMethod, ConnectionResult } from '../../domain/auth.js';
import { CodexAdapter } from './adapter.js';

// Return fixed messages, never raw provider output or credentials from an error.
export function connectionFailure(error: unknown, method: AuthMethod): string {
  const message = error instanceof Error ? error.message : '';
  const code = error instanceof AppError ? error.code : '';
  if (code === 'cancelled') return 'Connection test cancelled. Your saved login is still available.';
  if (/quota|credit.balance|spend.limit|usage.limit|billing|insufficient_quota/i.test(message)) {
    return method === 'chatgpt'
      ? 'Connection test blocked by your ChatGPT/Codex allowance. Check your plan’s Codex usage and reset time, or confirm the account used for sign-in. No API-key fallback was attempted.'
      : 'Connection test blocked by API credits or spending limits. Check https://platform.openai.com/settings/organization/billing/overview and organization limits, or run ./devagents start --auth chatgpt to use ChatGPT sign-in.';
  }
  if (/401|unauthoriz|expired|invalid.*key|missing_auth|not logged/i.test(`${code} ${message}`)) return 'Connection test could not authenticate. Run ./devagents start and sign in again with your preferred method.';
  if (/429|rate.limit|too many requests/i.test(message)) return 'The provider is temporarily rate-limiting requests. Wait before running the optional test again.';
  if (/model.*(not found|not exist|access)|model_not_found/i.test(message)) return 'The default Codex model is unavailable for this account. Check the account’s model access.';
  if (['engine_version', 'engine_unavailable'].includes(code)) return 'The Codex runtime is missing or incompatible. Rebuild with ./devagents start and run doctor if the problem continues.';
  if (code === 'vault_locked') return 'Credentials are locked. Run ./devagents start to unlock them from your OS keychain.';
  if (code === 'timeout' || /network|connect|dns|tls|fetch failed/i.test(message)) return 'Connection test could not reach the model in time. Check your internet connection and retry the optional test.';
  return 'Connection test failed. Your saved login is retained, but model access is not confirmed. Run doctor to check the runtime, or sign in again with ./devagents start.';
}

/** One opt-in, bounded model turn in an empty directory with no project access. */
export async function testCodexConnection(dataDir: string, method: AuthMethod, options: { engine?: CodingEngine; signal?: AbortSignal } = {}): Promise<ConnectionResult> {
  const cwd = await mkdtemp(join(tmpdir(), 'devagents-connection-'));
  const runId = `connection-${randomUUID()}`;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (!options.signal) process.once('SIGINT', cancel);
  try {
    const engine = options.engine ?? new CodexAdapter(dataDir);
    const result = await engine.execute({
      runId, cwd, phase: 'review', signal: options.signal ?? controller.signal, timeoutMs: 45000,
      provider: { id: 'openai', kind: 'openai', auth: 'login' },
      agent: { ...Agent.parse({ schemaVersion: 1, id: 'connection-check', name: 'Connection check', description: 'Check the saved Codex login', capabilities: ['review'], instructionsFile: 'unused', delegation: { canReceiveTasks: false, canDelegate: false }, permissions: { readPaths: ['project:/**'], writePaths: [], allowCommands: false } }), instructions: '', source: 'internal' },
      prompt: 'This is a connection check. Do not use tools. Return only the JSON object {"connected":true}.',
      schema: { type: 'object', properties: { connected: { type: 'boolean', enum: [true] } }, required: ['connected'], additionalProperties: false },
    }, () => {});
    if (!result.output || typeof result.output !== 'object' || (result.output as { connected?: unknown }).connected !== true) throw new AppError('invalid_response', 'Unexpected connection-check output');
    return { ok: true, message: 'Connection verified: the default Codex model responded. You can now register a project and run a task. Other agent models may have different access requirements.' };
  } catch (error) { return { ok: false, message: connectionFailure(error, method) }; }
  finally {
    process.removeListener('SIGINT', cancel);
    await rm(cwd, { recursive: true, force: true });
    await rm(resolve(dataDir, 'runs', runId), { recursive: true, force: true });
  }
}
