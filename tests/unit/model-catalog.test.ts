import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/persistence/store.js';
import { ModelCatalogService, claudeModelLister, codexModelLister } from '../../src/engines/model-catalog.js';

const withStore = async (run: (store: Store, root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), 'model-catalog-')); const store = await Store.open(join(root, 'devagents.db'), []);
  try { await run(store, root); } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
};

test('a loaded list is saved, marks what is new since the load before, and survives a failed load', () => withStore(async store => {
  let answer: unknown = [{ id: 'model-a', name: 'Model A' }, { id: 'model-a', name: 'Duplicate' }, { id: 'default', name: 'Default' }, { id: ' ', name: 'Blank' }];
  let clock = Date.parse('2026-11-18T09:00:00Z');
  const service = new ModelCatalogService(store, { codex: async () => { if (answer instanceof Error) throw answer; return answer as { id: string; name: string }[]; } }, () => new Date(clock));
  assert.deepEqual(await service.list(), [], 'nothing is listed before the first load');
  const first = await service.refresh('codex');
  assert.deepEqual(first, { engine: 'codex', models: [{ id: 'model-a', name: 'Model A' }], loadedAt: '2026-11-18T09:00:00.000Z', newIds: [] }, 'duplicates, blanks and the reserved default are dropped; the first load marks nothing new');
  answer = [{ id: 'model-b', name: '' }, { id: 'model-a', name: 'Model A' }]; clock += 60000;
  const second = await service.refresh('codex');
  assert.deepEqual(second.newIds, ['model-b']); assert.deepEqual(second.models[0], { id: 'model-b', name: 'model-b' }, 'a model without a name shows its ID');
  answer = new Error('provider said: secret-account-detail');
  await assert.rejects(service.refresh('codex'), (e: Error & { code?: string }) => e.code === 'model_list_failed' && !e.message.includes('secret-account-detail'), 'engine output never reaches the message');
  answer = [];
  await assert.rejects(service.refresh('codex'), /returned no models/);
  assert.deepEqual(await new ModelCatalogService(store, { codex: async () => [] }).list(), [second], 'the list loaded before is still saved');
  assert.throws(() => service.refresh('other-engine'), /cannot list models/);
}));

test('two refreshes of one engine share a single request', () => withStore(async store => {
  let calls = 0; let release = () => {};
  const service = new ModelCatalogService(store, { codex: () => new Promise(done => { calls++; release = () => done([{ id: 'model-a', name: 'Model A' }]); }) });
  const both = [service.refresh('codex'), service.refresh('codex')]; release();
  const [a, b] = await Promise.all(both); assert.equal(calls, 1); assert.deepEqual(a, b);
}));

test('Codex models are read from the app-server over pages, without hidden ones', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-models-')); const binary = join(root, 'codex'); const data = join(root, 'data'); await mkdir(join(data, 'engines', 'codex'), { recursive: true });
  await writeFile(binary, `#!${process.execPath}
if (process.argv.at(-1) !== 'app-server') process.exit(2);
const say = m => console.log(JSON.stringify(m));
let buffer = '';
process.stdin.on('data', d => { buffer += d; for (let i = buffer.indexOf('\\n'); i >= 0; i = buffer.indexOf('\\n')) { const m = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
  if (m.method === 'initialize') { say({ method: 'account/updated', params: {} }); say({ id: m.id, result: {} }); }
  if (m.method === 'model/list') say(m.params.cursor
    ? { id: m.id, result: { data: [{ id: 'second', model: 'model-second', displayName: 'Second', hidden: false }], nextCursor: null } }
    : { id: m.id, result: { data: [{ id: 'first', model: 'model-first', displayName: 'First', hidden: false }, { id: 'h', model: 'model-hidden', displayName: 'Hidden', hidden: true }], nextCursor: 'page-2' } });
} });
`, { mode: 0o700 });
  try {
    const list = codexModelLister(data, { id: 'openai', kind: 'openai', auth: 'login' }, binary);
    assert.deepEqual(await list(new AbortController().signal), [{ id: 'model-first', name: 'First' }, { id: 'model-second', name: 'Second' }]);
    await assert.rejects(codexModelLister(data, undefined, binary)(new AbortController().signal), /No OpenAI connection/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Claude models are saved as the exact model an alias resolves to, and no prompt is sent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-models-')); const old = process.env.ANTHROPIC_API_KEY; process.env.ANTHROPIC_API_KEY = 'fixture-anthropic-secret';
  let prompts = 0;
  try {
    const list = claudeModelLister(root, { id: 'anthropic', kind: 'anthropic', auth: 'api-key', apiKeyEnv: 'ANTHROPIC_API_KEY' }, { query: ({ prompt, options }) => {
      assert.equal(options.env!.ANTHROPIC_API_KEY, 'fixture-anthropic-secret'); assert.deepEqual(options.tools, []); assert.deepEqual(options.settingSources, []);
      void (async () => { for await (const _ of prompt) prompts++; })();
      return { supportedModels: async () => [{ value: 'default', resolvedModel: 'claude-sonnet-5-5', displayName: 'Default (recommended)' }, { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet' }, { value: 'custom-alias', displayName: 'Claude Custom' }] };
    } });
    assert.deepEqual(await list(new AbortController().signal), [{ id: 'claude-sonnet-5-5', name: 'Claude Sonnet' }, { id: 'custom-alias', name: 'Claude Custom' }]);
    assert.equal(prompts, 0);
  } finally { if (old === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = old; await rm(root, { recursive: true, force: true }); }
});
