import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, open, rename, rm, statfs } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { AppError } from '../domain/errors.js';

const aad = Buffer.from('devagents/codex-credentials/v1');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
async function optional(path: string): Promise<Buffer | undefined> {
  try { return await readFile(path); } catch (error) { if (missing(error)) return; throw error; }
}
async function atomic(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}
export class CredentialVault {
  readonly encrypted: string; readonly auth: string; readonly master: string;
  constructor(readonly dataDir: string, readonly runtimeDir: string) {
    this.encrypted = join(dataDir, 'credentials', 'codex.enc');
    this.auth = join(runtimeDir, 'codex', 'auth.json');
    this.master = join(runtimeDir, 'master.key');
  }
  async exists(): Promise<boolean> { return Boolean(await optional(this.encrypted)); }
  private decrypt(envelope: Buffer, key: Buffer): Buffer {
    try {
      const value = JSON.parse(envelope.toString('utf8'));
      if (value.version !== 1 || value.algorithm !== 'aes-256-gcm') throw new Error();
      const nonce = Buffer.from(value.nonce, 'base64'); const tag = Buffer.from(value.tag, 'base64');
      if (nonce.length !== 12 || tag.length !== 16) throw new Error();
      const cipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
      cipher.setAAD(aad); cipher.setAuthTag(tag);
      const plain = Buffer.concat([cipher.update(Buffer.from(value.ciphertext, 'base64')), cipher.final()]);
      JSON.parse(plain.toString('utf8')); return plain;
    } catch { throw new AppError('vault_integrity', 'Credential vault could not be decrypted. Restore the matching OS keychain entry; saved credentials were not overwritten.'); }
  }
  private async save(plain: Buffer, key: Buffer): Promise<void> {
    if (plain.length > 1024 * 1024) throw new AppError('credential_limit', 'Credential file exceeds its size limit');
    try { JSON.parse(plain.toString('utf8')); } catch { throw new AppError('invalid_credentials', 'Credential file is not valid JSON'); }
    const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    const envelope = Buffer.from(JSON.stringify({ version: 1, algorithm: 'aes-256-gcm', nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }));
    // Verify the envelope before replacing a previously usable vault.
    if (!this.decrypt(envelope, key).equals(plain)) throw new AppError('vault_integrity', 'Credential verification failed');
    await atomic(this.encrypted, envelope);
  }
  async unlock(hex: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(hex)) throw new AppError('invalid_master_key', 'Expected a 256-bit key from the OS credential store');
    const key = Buffer.from(hex, 'hex');
    const active = await optional(this.master);
    if (active && (active.length !== key.length || !timingSafeEqual(active, key))) throw new AppError('vault_locked', 'Runtime is already unlocked with a different key');
    const encrypted = await optional(this.encrypted);
    let plain = encrypted ? this.decrypt(encrypted, key) : undefined;
    const legacyPath = resolve(this.dataDir, 'engines', 'codex', 'auth.json');
    const legacy = await optional(legacyPath);
    if (legacy && plain && !legacy.equals(plain)) throw new AppError('credential_conflict', 'Both legacy and encrypted credentials exist with different contents; no credentials were changed');
    if (legacy && !plain) { await this.save(legacy, key); plain = legacy; }
    // Preserve a refreshed token already in the active runtime on repeated starts.
    const current = active ? await optional(this.auth) : undefined;
    if (current) await this.save(current, key);
    else if (plain) await atomic(this.auth, plain);
    await atomic(this.master, key);
    if (legacy) await rm(legacyPath);
  }
  async assertUnlocked(): Promise<void> {
    const key = await optional(this.master);
    if (!key || key.length !== 32) throw new AppError('vault_locked', 'Credentials are locked. Start DevAgents with ./devagents start to unlock them from your OS keychain.');
  }
  async seal(): Promise<void> {
    await this.assertUnlocked();
    const plain = await optional(this.auth);
    if (plain) await this.save(plain, await readFile(this.master));
  }
}
export const credentialRuntime = () => process.env.DEVAGENTS_CREDENTIAL_RUNTIME;
export const credentialStore = (): 'file' | 'keyring' => credentialRuntime() ? 'file' : 'keyring';
export async function configuredVault(dataDir: string): Promise<CredentialVault | undefined> {
  const runtime = credentialRuntime(); if (!runtime) return;
  // Never silently put decrypted credentials on a persistent filesystem.
  if (process.platform !== 'linux' || Number((await statfs(runtime)).type) !== 0x01021994) throw new AppError('memory_mount_required', 'Credential runtime must be a Linux tmpfs mount');
  return new CredentialVault(dataDir, runtime);
}
