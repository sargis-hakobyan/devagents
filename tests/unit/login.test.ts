import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../../src/persistence/store.js';
import { LoginAccounts } from '../../src/persistence/login-accounts.js';
import { PasswordLogin } from '../../src/auth/password.js';
import { loginConfig } from '../../src/auth/config.js';

test('shared login configuration is explicit and fails closed for unsupported providers and origins', () => {
  assert.deepEqual(loginConfig({}), { mode: 'local' });
  assert.deepEqual(loginConfig({ DEVAGENTS_MODE: 'shared', DEVAGENTS_PUBLIC_ORIGIN: 'https://devagents.example.test/' }), { mode: 'shared', provider: 'password', publicOrigin: 'https://devagents.example.test' });
  assert.equal(loginConfig({ DEVAGENTS_MODE: 'shared', DEVAGENTS_PUBLIC_ORIGIN: 'http://127.0.0.1:4310' }).mode, 'shared');
  for (const env of [
    { DEVAGENTS_MODE: 'typo' }, { DEVAGENTS_MODE: 'shared' },
    { DEVAGENTS_AUTH_PROVIDER: 'password' }, { DEVAGENTS_PUBLIC_ORIGIN: 'https://example.test' },
    ...['none', 'sso', 'local'].map(DEVAGENTS_AUTH_PROVIDER => ({ DEVAGENTS_MODE: 'shared', DEVAGENTS_AUTH_PROVIDER, DEVAGENTS_PUBLIC_ORIGIN: 'https://example.test' })),
    ...['http://example.test', 'https://example.test/ui', 'https://user:password@example.test', 'https://example.test?x=1', 'https://example.test#x', 'file:///tmp/login'].map(DEVAGENTS_PUBLIC_ORIGIN => ({ DEVAGENTS_MODE: 'shared', DEVAGENTS_PUBLIC_ORIGIN })),
  ]) assert.throws(() => loginConfig(env), /mode|origin|provider|authentication/i);
});

test('bootstrap stores a salted hash, preserves identity and credentials on restart, and never exposes the hash as identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devagents-login-')); const path = join(root, 'db.sqlite');
  new Store(path, []).close(); // Run application migrations, including the existing login tables.
  let store = new LoginAccounts(path);
  try {
    assert.equal(store.passwordAccount('admin'), undefined, 'opening a local store does not create logins');
    const provider = await PasswordLogin.create(store);
    const user = await provider.authenticate({ username: 'admin', password: 'admin' });
    assert.ok(user); assert.match(user.id, /^[a-f0-9-]{36}$/); assert.deepEqual(Object.keys(user).sort(), ['id', 'name', 'role']);
    const saved = store.passwordAccount('admin')!;
    assert.match(saved.salt, /^[a-f0-9]{32}$/); assert.match(saved.hash, /^[a-f0-9]{128}$/);
    assert.notEqual(saved.hash, 'admin');
    for (const input of [{ username: 'admin', password: 'wrong' }, { username: 'unknown', password: 'admin' }, { username: 'admin', password: 'admin', role: 'admin' }, { username: 'admin', password: 'a'.repeat(1025) }, null]) {
      assert.equal(await provider.authenticate(input), undefined);
    }
    store.close(); store = new LoginAccounts(path);
    const restarted = await PasswordLogin.create({
      passwordAccount: async username => store.passwordAccount(username),
      bootstrapPasswordAccount: async (...args) => store.bootstrapPasswordAccount(...args),
    });
    assert.deepEqual(store.passwordAccount('admin'), saved);
    assert.deepEqual(await restarted.authenticate({ username: 'admin', password: 'admin' }), user);
    // An existing credential is authoritative even if it no longer matches the bootstrap password.
    const raw = new DatabaseSync(path); raw.prepare('UPDATE password_accounts SET hash=?').run('00'.repeat(64)); raw.close();
    const changed = await PasswordLogin.create(store);
    assert.equal(await changed.authenticate({ username: 'admin', password: 'admin' }), undefined);
    assert.deepEqual(store.loginUser(user.id), user);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
