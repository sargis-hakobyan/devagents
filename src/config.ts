import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { Config, type AppConfig } from './domain/schemas.js';

export async function loadConfig(path = process.env.DEVAGENTS_CONFIG): Promise<AppConfig> {
  return Config.parse(path ? parse(await readFile(resolve(path), 'utf8')) : { schemaVersion: 1 });
}
export function dataDirectory(): string { return resolve(process.env.DEVAGENTS_DATA_DIR ?? '.devagents'); }
