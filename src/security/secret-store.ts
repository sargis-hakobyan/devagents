import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AppError } from '../domain/errors.js';
import { configuredVault } from './credential-vault.js';

/**
 * Named secrets the service itself uses (integration tokens). Unlike engine credentials they are
 * never materialized as a runtime file: the value is decrypted on demand and held only in memory.
 */
export interface SecretStore {
  readonly mode: 'vault' | 'environment';
  locked(): Promise<boolean>;
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  remove(name: string): Promise<void>;
  /** Environment mode: the variable a secret is read from. */
  variable(name: string): string;
}
const Name = /^[a-z][a-z0-9-]{0,127}$/;
function checked(name: string): string {
  if (!Name.test(name)) throw new AppError('invalid_secret_name', 'Secret names use lowercase letters, digits and dashes');
  return name;
}
/** `github-my-project` reads `DEVAGENTS_GITHUB_TOKEN_MY_PROJECT`. */
export function secretVariable(name: string): string {
  const [kind, ...rest] = checked(name).split('-');
  return `DEVAGENTS_${kind!.toUpperCase()}_TOKEN_${rest.join('_').toUpperCase()}`;
}
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** AES-256-GCM files under `<dataDir>/credentials/integrations`, keyed by the unlocked runtime master key. */
export class VaultSecretStore implements SecretStore {
  readonly mode = 'vault' as const;
  constructor(private readonly dataDir: string, private readonly runtimeDir: string) {}
  variable(name: string) { return secretVariable(name); }
  private file(name: string) { return join(this.dataDir, 'credentials', 'integrations', `${checked(name)}.enc`); }
  private aad(name: string) { return Buffer.from(`devagents/integration/${name}/v1`); }
  private async key(): Promise<Buffer> {
    let key: Buffer | undefined;
    try { key = await readFile(join(this.runtimeDir, 'master.key')); } catch (error) { if (!missing(error)) throw error; }
    if (!key || key.length !== 32) throw new AppError('vault_locked', 'Credentials are locked. Start DevAgents with ./devagents start to unlock them from your OS keychain.', 409);
    return key;
  }
  async locked(): Promise<boolean> {
    try { await this.key(); return false; } catch (error) { if (error instanceof AppError && error.code === 'vault_locked') return true; throw error; }
  }
  async get(name: string): Promise<string | undefined> {
    let envelope: Buffer;
    try { envelope = await readFile(this.file(name)); } catch (error) { if (missing(error)) return; throw error; }
    const key = await this.key();
    try {
      const value = JSON.parse(envelope.toString('utf8'));
      if (value.version !== 1 || value.algorithm !== 'aes-256-gcm') throw new Error();
      const nonce = Buffer.from(value.nonce, 'base64'); const tag = Buffer.from(value.tag, 'base64');
      if (nonce.length !== 12 || tag.length !== 16) throw new Error();
      const cipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
      cipher.setAAD(this.aad(name)); cipher.setAuthTag(tag);
      return Buffer.concat([cipher.update(Buffer.from(value.ciphertext, 'base64')), cipher.final()]).toString('utf8');
    } catch { throw new AppError('vault_integrity', 'A saved token could not be decrypted. Replace the token; nothing was overwritten.', 409); }
  }
  async set(name: string, value: string): Promise<void> {
    if (!value || value.length > 4096 || /\s/.test(value)) throw new AppError('invalid_token', 'Expected one token without whitespace');
    const path = this.file(name); const key = await this.key();
    const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    cipher.setAAD(this.aad(name));
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(value, 'utf8')), cipher.final()]);
    const envelope = JSON.stringify({ version: 1, algorithm: 'aes-256-gcm', nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(envelope); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }
  async remove(name: string): Promise<void> { await rm(this.file(name), { force: true }); }
}

/**
 * Native installs have no service-owned secret store, so tokens come from the environment, like the
 * native Claude key. Saving a pasted token is refused rather than written to disk in plain text.
 */
export class EnvironmentSecretStore implements SecretStore {
  readonly mode = 'environment' as const;
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}
  variable(name: string) { return secretVariable(name); }
  async locked() { return false; }
  async get(name: string) { return this.env[secretVariable(name)] || undefined; }
  async set(name: string, _value: string): Promise<void> {
    throw new AppError('vault_unconfigured', `This service has no encrypted vault, so a pasted token cannot be saved. Use the Docker launcher, or set ${secretVariable(name)} for the native service and connect without a token.`, 409);
  }
  async remove(_name: string) { /* The variable belongs to the user's environment. */ }
}

export async function configuredSecretStore(dataDir: string): Promise<SecretStore> {
  // configuredVault performs the tmpfs check, so a decryption key is never read from persistent storage.
  const vault = await configuredVault(dataDir);
  return vault ? new VaultSecretStore(dataDir, vault.runtimeDir) : new EnvironmentSecretStore();
}
