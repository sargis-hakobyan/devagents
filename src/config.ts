import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { Config, type AppConfig } from './domain/schemas.js';
import { AppError } from './domain/errors.js';

export async function loadConfig(path = process.env.DEVAGENTS_CONFIG): Promise<AppConfig> {
  const config = Config.parse(path ? parse(await readFile(resolve(path), 'utf8')) : { schemaVersion: 1 });
  const rules = process.env.DEVAGENTS_RULES;
  if (rules !== undefined && rules !== '') {
    if (rules !== 'true' && rules !== 'false') throw new AppError('invalid_config', 'DEVAGENTS_RULES must be true or false');
    config.devagentsRules = rules === 'true';
  }
  return config;
}
export function dataDirectory(): string { return resolve(process.env.DEVAGENTS_DATA_DIR ?? '.devagents'); }
