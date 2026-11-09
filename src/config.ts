import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { Config, type AppConfig } from './domain/schemas.js';
import { AppError } from './domain/errors.js';

export async function loadConfig(path = process.env.DEVAGENTS_CONFIG): Promise<AppConfig> {
  const config = Config.parse(path ? parse(await readFile(resolve(path), 'utf8')) : { schemaVersion: 1 });
  for (const [key, variable] of [['maxConcurrentTasks', 'DEVAGENTS_MAX_CONCURRENT_TASKS'], ['maxConcurrentOperations', 'DEVAGENTS_MAX_CONCURRENT_OPERATIONS']] as const) {
    const value = process.env[variable];
    if (value !== undefined && value !== '') config[key] = Config.shape[key].parse(Number(value));
  }
  const rules = process.env.DEVAGENTS_RULES;
  if (rules !== undefined && rules !== '') {
    if (rules !== 'true' && rules !== 'false') throw new AppError('invalid_config', 'DEVAGENTS_RULES must be true or false');
    config.devagentsRules = rules === 'true';
  }
  const compact = process.env.DEVAGENTS_COMPACT_COMPLETED_TASKS;
  if (compact !== undefined && compact !== '') {
    if (compact !== 'true' && compact !== 'false') throw new AppError('invalid_config', 'DEVAGENTS_COMPACT_COMPLETED_TASKS must be true or false');
    config.compactCompletedTasks = compact === 'true';
  }
  const cleanup = process.env.DEVAGENTS_CLEANUP_TERMINAL_TASKS;
  if (cleanup !== undefined && cleanup !== '') {
    if (cleanup !== 'true' && cleanup !== 'false') throw new AppError('invalid_config', 'DEVAGENTS_CLEANUP_TERMINAL_TASKS must be true or false');
    config.cleanupTerminalTasks = cleanup === 'true';
  }
  return config;
}
export function dataDirectory(): string { return resolve(process.env.DEVAGENTS_DATA_DIR ?? '.devagents'); }
