import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { EnvironmentSecretStore, VaultSecretStore, secretVariable } from '../../src/security/secret-store.js';
import { AppError } from '../../src/domain/errors.js';

const code = (expected: string) => (error: unknown) => error instanceof AppError && error.code === expected;

test('vault secrets are encrypted at rest, bound to their name and need the unlocked master key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devagents-secrets-'));
  const data = join(root, 'data'); const runtime = join(root, 'runtime'); await mkdir(runtime, { recursive: true });
  const store = new VaultSecretStore(data, runtime); const value = 'fixture-token-value-0123456789';
  try {
    assert.equal(await store.locked(), true);
    await assert.rejects(store.set('github-website', value), code('vault_locked'));
    await writeFile(join(runtime, 'master.key'), randomBytes(32));
    assert.equal(await store.locked(), false);
    assert.equal(await store.get('github-website'), undefined);
    await store.set('github-website', value);
    assert.equal(await store.get('github-website'), value);
    const directory = join(data, 'credentials', 'integrations');
    assert.deepEqual(await readdir(directory), ['github-website.enc']);
    const stored = await readFile(join(directory, 'github-website.enc'), 'utf8');
    assert.equal(stored.includes(value), false, 'the token is not stored in plain text');
    // An envelope copied under another name fails authentication instead of answering for it.
    await writeFile(join(directory, 'jira-website.enc'), stored);
    await assert.rejects(store.get('jira-website'), code('vault_integrity'));
    await writeFile(join(runtime, 'master.key'), randomBytes(32));
    await assert.rejects(store.get('github-website'), code('vault_integrity'));
    await rm(join(runtime, 'master.key'));
    await assert.rejects(store.get('github-website'), code('vault_locked'));
    await store.remove('github-website'); await store.remove('github-website');
    assert.deepEqual((await readdir(directory)).sort(), ['jira-website.enc']);
    await assert.rejects(store.set('../escape', value), code('invalid_secret_name'));
    await assert.rejects(store.get('Not-Lowercase'), code('invalid_secret_name'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('native secrets come from the environment and a pasted token is refused, never written', async () => {
  assert.equal(secretVariable('github-my-project'), 'DEVAGENTS_GITHUB_TOKEN_MY_PROJECT');
  assert.equal(secretVariable('jira-website'), 'DEVAGENTS_JIRA_TOKEN_WEBSITE');
  const store = new EnvironmentSecretStore({ DEVAGENTS_JIRA_TOKEN_WEBSITE: 'from-environment' });
  assert.equal(store.mode, 'environment'); assert.equal(await store.locked(), false);
  assert.equal(await store.get('jira-website'), 'from-environment');
  assert.equal(await store.get('github-website'), undefined);
  await assert.rejects(store.set('github-website', 'pasted'), (error: unknown) => code('vault_unconfigured')(error) && (error as AppError).message.includes('DEVAGENTS_GITHUB_TOKEN_WEBSITE'));
  await store.remove('jira-website'); assert.equal(await store.get('jira-website'), 'from-environment');
});
