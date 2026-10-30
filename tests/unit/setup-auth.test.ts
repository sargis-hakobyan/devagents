import test from 'node:test';
import assert from 'node:assert/strict';
import { SetupAuth } from '../../src/setup/auth.js';
import { projectMount, checkExistingMounts } from '../../src/cli/project-mount.js';
import { parse } from 'yaml';

test('setup jobs are owned, deduplicated, cancellable and never expose credential input or provider errors', async () => {
  let calls = 0;
  const setup = new SetupAuth({ status: async () => ({ saved: false }), login: async (_m, _key, signal, challenge) => {
    calls++; challenge({ url: 'https://auth.openai.com/codex/device', code: 'ABCD-12345' });
    await new Promise<void>((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('private-provider-value'))); });
  } });
  const input = { attemptId: crypto.randomUUID(), method: 'api-key', apiKey: 'private-provider-value' };
  setup.start('owner', input); setup.start('owner', input); assert.equal(calls, 1);
  assert.throws(() => setup.start('owner', { ...input, apiKey: 'different' }), { code: 'attempt_conflict' });
  assert.throws(() => setup.start('other', { ...input, attemptId: crypto.randomUUID() }), { code: 'setup_busy' });
  assert.equal((await setup.status('other')).job, undefined);
  assert.doesNotMatch(JSON.stringify(await setup.status('owner')), /private-provider-value/);
  await assert.rejects(setup.cancel('other'), { code: 'not_found' });
  const result = await setup.cancel('owner'); assert.equal(result.state, 'cancelled'); assert.equal(result.challenge, undefined);
  assert.doesNotMatch(JSON.stringify(result), /private-provider-value/);
  await setup.close(); assert.throws(() => setup.start('owner', input), { code: 'setup_unavailable' });
});

test('setup confirms the requested method and sanitizes failure; active work prevents login', async () => {
  const setup = new SetupAuth({ status: async () => ({ saved: true, method: 'api-key' }), login: async () => {} });
  setup.start('owner', { attemptId: crypto.randomUUID(), method: 'chatgpt' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await setup.status('owner')).job?.state, 'failed');
  const busy = new SetupAuth({ status: async () => ({ saved: false }), login: async () => { throw new Error('Must not run'); } }, () => { throw new Error('Active work'); });
  assert.throws(() => busy.start('owner', { attemptId: crypto.randomUUID(), method: 'chatgpt' }), /Active work/);
});

test('managed project mounts are additive, literal, non-destructive and reject repointing or malformed config', () => {
  assert.throws(() => checkExistingMounts({ services: { devagents: { volumes: [{ target: '/projects/one', source: '/original' }] } } }, 'one', '/replacement'));
  const first = projectMount('', 'one', '/Users/me/project $special');
  assert.equal(parse(first).services.devagents.volumes[0].source, '/Users/me/project $$special');
  const next = projectMount(first, 'two', '/projects/second');
  assert.equal(parse(next).services.devagents.volumes.length, 2);
  assert.equal(projectMount(next, 'two', '/projects/second'), next);
  assert.equal(parse(next).services.devagents.volumes[1].bind.create_host_path, false);
  assert.throws(() => projectMount(next, 'two', '/other'));
  assert.throws(() => projectMount(next, 'three', '/projects/second'));
  assert.throws(() => projectMount('services: { devagents: { privileged: true } }', 'x', '/project'));
  for (const path of ['/', 'relative', '/path\nwith-newline', '/path,comma']) assert.throws(() => projectMount('', 'x', path));
});
