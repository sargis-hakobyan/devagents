import { loginSchema } from './login-schema.js';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { LoginAccountStore, PasswordAccount } from '../auth/types.js';
import type { UserDirectory, UserIdentity } from '../domain/identity.js';

/** Uses the existing, migrated database; owns only its login-account connection. */
export class LoginAccounts implements LoginAccountStore, UserDirectory {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.db.exec(loginSchema);
  }
  hasUsers(): boolean { return Boolean(this.db.prepare('SELECT 1 FROM users LIMIT 1').get()); }
  close(): void { this.db.close(); }

  loginUser(id: string): UserIdentity | undefined {
    return this.db.prepare('SELECT id, name, role FROM users WHERE id=?').get(id) as UserIdentity | undefined;
  }
  passwordAccount(username: string): PasswordAccount | undefined {
    const row = this.db.prepare('SELECT user_id, salt, hash FROM password_accounts WHERE username=?').get(username) as { user_id: string; salt: string; hash: string } | undefined;
    return row ? { user: this.loginUser(row.user_id)!, salt: row.salt, hash: row.hash } : undefined;
  }
  bootstrapPasswordAccount(username: string, name: string, salt: string, hash: string): UserIdentity {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.passwordAccount(username);
      if (existing) {
        this.db.exec('COMMIT');
        return existing.user;
      }
      const user: UserIdentity = { id: randomUUID(), name, role: 'admin' };
      this.db.prepare('INSERT INTO users (id, name, role) VALUES (?, ?, ?)').run(user.id, user.name, user.role);
      this.db.prepare('INSERT INTO password_accounts (username, user_id, salt, hash) VALUES (?, ?, ?, ?)').run(username, user.id, salt, hash);
      this.db.exec('COMMIT');
      return user;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
