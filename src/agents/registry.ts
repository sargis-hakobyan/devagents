import { readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { Agent, type AgentDefinition, type AppConfig } from '../domain/schemas.js';
import { AppError } from '../domain/errors.js';
import { isWithin } from '../workspace/paths.js';

export const builtinDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../agents/builtin');
export const builtinCapabilities = new Set(['planning', 'implementation', 'backend', 'frontend', 'testing', 'review', 'documentation', 'filesystem-read', 'filesystem-write']);

export async function loadRegistry(directories: string[], config: AppConfig, capabilities = builtinCapabilities, engines = new Set(['codex', 'claude-code'])): Promise<AgentDefinition[]> {
  const result = new Map<string, AgentDefinition>();
  for (const directory of directories) {
    let entries: string[];
    try { entries = await readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    const root = await realpath(directory); const layerIds = new Set<string>();
    for (const filename of entries.filter(f => /\.ya?ml$/.test(f)).sort()) {
      const source = await realpath(join(root, filename));
      if (!isWithin(root, source)) throw new AppError('invalid_agent', 'Agent YAML symlink escapes its directory');
      const agent = Agent.parse(parse(await readFile(source, 'utf8')));
      if (layerIds.has(agent.id)) throw new AppError('invalid_agent', `Duplicate agent ID in one layer: ${agent.id}`);
      layerIds.add(agent.id);
      if (agent.capabilities.some(c => !capabilities.has(c))) throw new AppError('missing_capability', `Agent ${agent.id} references an unavailable capability`);
      if (!engines.has(agent.engine === 'default' ? config.defaultEngine : agent.engine)) throw new AppError('invalid_agent', `Unknown engine for ${agent.id}`);
      if (!config.providers.some(p => p.id === (agent.provider === 'default' ? config.defaultProvider : agent.provider))) throw new AppError('invalid_agent', `Unknown provider for ${agent.id}`);
      if (agent.delegation.canDelegate && agent.delegation.canReceiveTasks) throw new AppError('invalid_agent', 'Nested delegation is not supported; delegators cannot receive delegated tasks');
      if (isAbsolute(agent.instructionsFile) || agent.instructionsFile.includes('\\') || agent.instructionsFile.split('/').includes('..') || !agent.instructionsFile.endsWith('.md')) throw new AppError('invalid_agent', 'instructionsFile must be a relative Markdown file without traversal');
      const instructionsPath = await realpath(resolve(root, agent.instructionsFile));
      if (!isWithin(root, instructionsPath)) throw new AppError('invalid_agent', 'Instructions symlink escapes agent directory');
      const instructions = await readFile(instructionsPath, 'utf8');
      if (instructions.length > 64000) throw new AppError('invalid_agent', 'Agent instructions exceed 64KB');
      result.set(agent.id, { ...agent, instructions, source });
    }
  }
  return [...result.values()];
}
