import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { LoginAccountStore, LoginProvider } from './types.js';
import type { UserIdentity } from '../domain/identity.js';

const credentials = z.strictObject({ username: z.string().min(1).max(100), password: z.string().min(1).max(1024) });
const derive = (password: string, salt: string) => new Promise<Buffer>((resolve, reject) => {
  scrypt(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key));
});

export class PasswordLogin implements LoginProvider {
  readonly id = 'password';
  private readonly dummySalt = randomBytes(16).toString('hex');
  constructor(private readonly store: LoginAccountStore) {}

  static async create(store: LoginAccountStore): Promise<PasswordLogin> {
    if (!await store.passwordAccount('admin')) {
      const salt = randomBytes(16).toString('hex');
      // Explicit initial account requested for the shared-server foundation. Never reset on restart.
      await store.bootstrapPasswordAccount('admin', 'Administrator', salt, (await derive('admin', salt)).toString('hex'));
    }
    return new PasswordLogin(store);
  }

  async authenticate(input: unknown): Promise<UserIdentity | undefined> {
    const parsed = credentials.safeParse(input);
    if (!parsed.success) return undefined;
    const account = await this.store.passwordAccount(parsed.data.username);
    // Unknown usernames take the same expensive password-derivation path.
    const key = await derive(parsed.data.password, account?.salt ?? this.dummySalt);
    const expected = account ? Buffer.from(account.hash, 'hex') : Buffer.alloc(64);
    return expected.length === key.length && timingSafeEqual(key, expected) ? account?.user : undefined;
  }
}
