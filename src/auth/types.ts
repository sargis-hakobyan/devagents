import type { UserIdentity } from '../domain/identity.js';

export type PasswordAccount = { user: UserIdentity; salt: string; hash: string };

/** Implemented by persistence, so login providers do not depend on database or HTTP implementations. */
export interface LoginAccountStore {
  passwordAccount(username: string): PasswordAccount | undefined | Promise<PasswordAccount | undefined>;
  bootstrapPasswordAccount(username: string, name: string, salt: string, hash: string): UserIdentity | Promise<UserIdentity>;
}

export interface LoginProvider {
  readonly id: string;
  authenticate(input: unknown): Promise<UserIdentity | undefined>;
}

export const LOCAL_USER: UserIdentity = { id: 'local', name: 'Local user', role: 'admin' };
