// Synthetic users for compose.workspaces.yaml only. Never run against a service data directory.
import { openWorkspace } from '/app/dist/persistence/workspace-database.js';
import { scryptSync, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';

const dbPath = '/data/accounts.db';
if (existsSync('/data/devagents.db')) throw new Error('The demo requires a dedicated gateway volume');
const db = await openWorkspace(dbPath, 'accounts');
try {
  await db.begin();
  for (const [username, id] of [['alice', '11111111-1111-4111-8111-111111111111'], ['bob', '22222222-2222-4222-8222-222222222222']]) {
    const existing = await db.prepare('SELECT user_id FROM password_accounts WHERE username=$1').get(username);
    if (existing?.user_id === id) continue;
    if (existing) throw new Error('Unexpected account in demo volume');
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync('demo-' + username, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
    await db.prepare('INSERT INTO users VALUES ($1, $2, $3)').run(id, username, 'admin');
    await db.prepare('INSERT INTO password_accounts VALUES ($1, $2, $3, $4)').run(username, id, salt, hash.toString('hex'));
  }
  await db.exec('COMMIT');
} finally { await db.close(); }
