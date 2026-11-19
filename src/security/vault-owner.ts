import { createHash } from 'node:crypto';
import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PgSession } from '../persistence/pg-session.js';
import { AppError } from '../domain/errors.js';

const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch (error) { if (missing(error)) return false; throw error; }
}

export async function sharedVaultOwner(dataDir: string): Promise<string> {
  const db = await PgSession.open(join(dataDir, 'devagents.db'));
  try {
    const owner = (await db.prepare('SELECT user_id FROM workspace_owner WHERE singleton=1').get())?.user_id;
    if (typeof owner !== 'string') throw new AppError('missing_workspace_owner', 'Start the shared service before unlocking its vault');
    return owner;
  } finally { await db.close(); }
}

export async function vaultMaterialExists(dataDir: string, runtimeDir: string): Promise<boolean> {
  for (const path of ['kms-vault-binding', 'credentials/codex.enc', 'credentials/claude.enc', 'engines/codex/auth.json', 'engines/claude/auth.json']) {
    if (await exists(join(dataDir, path))) return true;
  }
  for (const path of ['master.key', 'codex/auth.json', 'claude/auth.json']) {
    if (await exists(join(runtimeDir, path))) return true;
  }
  try { return (await readdir(join(dataDir, 'credentials', 'integrations'))).some(name => name.endsWith('.enc')); }
  catch (error) { if (missing(error)) return false; throw error; }
}

/** Pin the key before the first KMS-backed unlock. Refuse silent rekeying or a switch back to the OS keychain. */
export async function verifyVaultBinding(dataDir: string, runtimeDir: string, master: string, owner?: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(master)) throw new AppError('invalid_master_key', 'Expected a 256-bit vault key');
  const path = join(dataDir, 'kms-vault-binding');
  let previous: string | undefined;
  try { previous = await readFile(path, 'utf8'); }
  catch (error) { if (!missing(error)) throw error; }
  if (!owner) {
    if (previous !== undefined) throw new AppError('vault_key_source', 'This workspace requires its KMS-protected key');
    return;
  }
  if (owner !== await sharedVaultOwner(dataDir)) throw new AppError('vault_owner', 'The vault belongs to a different workspace owner');
  const digest = createHash('sha256').update(Buffer.from(master, 'hex')).digest('hex');
  const binding = JSON.stringify({ owner, digest });
  if (previous === binding) return;
  if (previous !== undefined || await vaultMaterialExists(dataDir, runtimeDir)) {
    throw new AppError('vault_key_conflict', 'Existing credentials require their original vault key');
  }
  await writeFile(path, binding, { flag: 'wx', mode: 0o600, flush: true });
}
