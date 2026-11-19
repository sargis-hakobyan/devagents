// Synthetic users for compose.workspaces.yaml only. Never run against a service data directory.
import { DatabaseSync } from 'node:sqlite';
import { scryptSync, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { loginSchema } from '/app/dist/persistence/login-schema.js';

const dbPath = '/data/accounts.db';
const db = new DatabaseSync(dbPath);
if (existsSync('/data/devagents.db')) throw new Error('The demo requires a dedicated gateway volume');
try {
  db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;');
  db.exec(loginSchema);
  for (const [username, id] of [['alice', '11111111-1111-4111-8111-111111111111'], ['bob', '22222222-2222-4222-8222-222222222222']]) {
    const existing = db.prepare('SELECT user_id FROM password_accounts WHERE username=?').get(username);
    if (existing?.user_id === id) continue;
    if (existing) throw new Error('Unexpected account in demo volume');
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync('demo-' + username, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
    db.prepare('INSERT INTO users VALUES (?, ?, ?)').run(id, username, 'admin');
    db.prepare('INSERT INTO password_accounts VALUES (?, ?, ?, ?)').run(username, id, salt, hash.toString('hex'));
  }
  db.exec('COMMIT');
} finally { db.close(); }
