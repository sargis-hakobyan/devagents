import { randomUUID } from 'node:crypto';
import type { LoginAccountStore, PasswordAccount } from '../auth/types.js';
import type { UserDirectory, UserIdentity } from '../domain/identity.js';
import { openWorkspace } from './workspace-database.js';
import { prismaFor } from './prisma.js';

function identity(row: { id: string; name: string; role: string }): UserIdentity {
  if (row.role !== 'admin') throw Error('Unsupported stored account role');
  return { id: row.id, name: row.name, role: row.role };
}

export class LoginAccounts implements LoginAccountStore, UserDirectory {
  private readonly client;
  static async open(path: string): Promise<LoginAccounts> {
    await (await openWorkspace(path, 'accounts')).close();
    return new LoginAccounts(path);
  }
  private constructor(path: string) {
    this.client = prismaFor(path).client;
  }

  async hasUsers() { return (await this.client.user.findFirst({ select: { id: true } })) !== null; }
  close() { return this.client.$disconnect(); }

  async loginUser(id: string): Promise<UserIdentity | undefined> {
    const user = await this.client.user.findUnique({ where: { id } });
    return user ? identity(user) : undefined;
  }

  async passwordAccount(username: string): Promise<PasswordAccount | undefined> {
    const account = await this.client.passwordAccount.findUnique({ where: { username }, include: { users: true } });
    return account ? { user: identity(account.users), salt: account.salt, hash: account.hash } : undefined;
  }

  async bootstrapPasswordAccount(username: string, name: string, salt: string, hash: string): Promise<UserIdentity> {
    return this.client.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${username}, 2))`;
      const existing = await tx.passwordAccount.findUnique({ where: { username }, select: { users: true } });
      if (existing) return identity(existing.users);
      const user = { id: randomUUID(), name, role: 'admin' as const };
      await tx.user.create({ data: { ...user, password_accounts: { create: { username, salt, hash } } } });
      return user;
    });
  }
}
