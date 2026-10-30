import test from 'node:test';
import assert from 'node:assert/strict';
import { onboard, type SetupUI } from '../../src/cli/onboarding.js';
import type { AuthSetup, AuthMethod, AuthStatus } from '../../src/domain/auth.js';

function fixture(initial: AuthStatus, answers: string[] = [], interactive = true) {
  let status = initial; const messages: string[] = []; const logins: AuthMethod[] = []; const checks: AuthMethod[] = [];
  const auth: AuthSetup = {
    status: async () => status,
    login: async method => { logins.push(method); status = { saved: true, method }; },
    test: async method => { checks.push(method); return { ok: true, message: 'Verified fixture' }; },
  };
  const ui: SetupUI = { interactive, write: text => messages.push(text), ask: async text => {
    messages.push(text); assert.ok(answers.length, 'unexpected prompt'); return answers.shift()!;
  } };
  return { auth, ui, messages, logins, checks };
}
test('new user can choose ChatGPT; no model call on skip and no API-key fallback', async () => {
  const f = fixture({ saved: false }, ['wrong', '1', '']);
  assert.equal(await onboard(f.auth, f.ui), true);
  assert.deepEqual(f.logins, ['chatgpt']); assert.deepEqual(f.checks, []);
  assert.ok(f.messages.some(m => m.includes('settings/Security')));
  assert.ok(f.messages.some(m => m.includes('not been checked')));
});
test('saved API-key user can switch to ChatGPT and opt in to a model test', async () => {
  const f = fixture({ saved: true, method: 'api-key' }, ['1', 'maybe', 'y']);
  assert.equal(await onboard(f.auth, f.ui), true);
  assert.deepEqual(f.logins, ['chatgpt']); assert.deepEqual(f.checks, ['chatgpt']);
});
test('saved login default does not repeat sign-in or make a model request', async () => {
  for (const method of ['chatgpt', 'api-key', 'unknown'] as const) {
    const f = fixture({ saved: true, method }, ['', 'n']);
    assert.equal(await onboard(f.auth, f.ui), true);
    assert.deepEqual(f.logins, []); assert.deepEqual(f.checks, []);
  }
});
test('API-key choice and explicit test; failed check returns failure without changing login', async () => {
  const f = fixture({ saved: false }, []);
  f.auth.test = async method => { f.checks.push(method); return { ok: false, message: 'Quota exhausted' }; };
  assert.equal(await onboard(f.auth, f.ui, { auth: 'api-key', testConnection: true }), false);
  assert.deepEqual(f.logins, ['api-key']); assert.deepEqual(f.checks, ['api-key']);
});
test('noninteractive startup reuses credentials only and tests only when explicitly requested', async () => {
  const f = fixture({ saved: true, method: 'chatgpt' }, [], false);
  await onboard(f.auth, f.ui); assert.deepEqual(f.checks, []);
  await onboard(f.auth, f.ui, { testConnection: true }); assert.deepEqual(f.checks, ['chatgpt']);
  await assert.rejects(onboard(f.auth, f.ui, { auth: 'api-key' }), /interactive terminal/);
  const missing = fixture({ saved: false }, [], false);
  await assert.rejects(onboard(missing.auth, missing.ui), /No saved login/);
});
test('cancelled sign-in and wrong auth method never continue or test the old key', async () => {
  const f = fixture({ saved: true, method: 'api-key' }, []);
  f.auth.login = async () => { throw new Error('cancelled'); };
  await assert.rejects(onboard(f.auth, f.ui, { auth: 'chatgpt', testConnection: true }), /cancelled/);
  f.auth.login = async () => {};
  await assert.rejects(onboard(f.auth, f.ui, { auth: 'chatgpt', testConnection: true }), /not confirmed/);
  assert.deepEqual(f.checks, []);
});
