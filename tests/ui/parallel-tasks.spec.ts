import { test, expect } from '@playwright/test';
import type { AddressInfo } from 'node:net';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from '../helpers.js';
import { FakeEngine, FixtureValidator } from '../fixtures/fake-engine.js';
import { TaskRunner } from '../../src/orchestration/runner.js';
import { createApi } from '../../src/api/server.js';
import { fixtureDir, port } from './playwright.config.js';

test('parallel tasks expose real capacity, independent cancellation and retained recovery attention', async ({ page }) => {
  const f = await fixture(); f.service.config.maxConcurrentTasks = 3; f.service.config.maxConcurrentOperations = 3;
  const engine = new FakeEngine({ waitForCancel: true }); const execute = engine.execute.bind(engine);
  let notify!: () => void; const started = new Promise<void>(r => { notify = r; }); let count = 0;
  engine.execute = async request => { if (request.phase === 'implementation' && ++count === 3) notify(); return execute(request); };
  const runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
  const fixtureToken = (await readFile(join(fixtureDir, 'api-token'), 'utf8')).trim();
  const status = await (await fetch(`http://127.0.0.1:${port}/status`, { headers: { authorization: `Bearer ${fixtureToken}` } })).json();
  const token = 'synthetic-parallel-browser-token';
  const server = createApi(f.service, token, { uiRoot: join(process.cwd(), 'dist/ui'), status: async () => status });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const tasks = ['Parallel A', 'Parallel B', 'Parallel C', 'Queued D'].map(request => f.service.submit({ projectId: 'fixture', request, mode: 'autonomous' }, request));
    await started;
    expect((await fetch(`${origin}/scheduler`)).status).toBe(401);
    const bootstrap = await fetch(`${origin}/ui/bootstrap`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
    await page.goto((await bootstrap.json()).url);
    for (const task of tasks.slice(0, 3)) await expect(page.locator(`a[href="/ui/tasks/${task.id}"]`)).toBeVisible();
    await expect(page.getByText('3 / 3 task slots in use · 1 queued · 3 / 3 operations running', { exact: true })).toBeVisible();
    await page.goto(`${origin}/ui/tasks/${tasks[3]!.id}`);
    await expect(page.getByText('Queued for execution', { exact: true })).toBeVisible();
    await expect(page.getByText('Waiting for an available task slot', { exact: true })).toBeVisible();
    await page.goto(`${origin}/ui/tasks/${tasks[0]!.id}`);
    await page.getByRole('button', { name: 'Cancel task…', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm cancellation' }).click();
    await expect.poll(() => f.store.task(tasks[3]!.id).state).toBe('running');
    expect(f.store.task(tasks[1]!.id).state).toBe('running'); expect(f.store.task(tasks[2]!.id).state).toBe('running');
    const held = f.service.submit({ projectId: 'fixture', request: 'Interrupted fixture needing inspection', mode: 'autonomous' }, 'held');
    f.store.transition(held.id, held.version, 'failed', 'fixture', 'Simulated interruption');
    f.store.recoverDispatch(held.id, 'Prior worker termination needs inspection.');
    await page.goto(`${origin}/ui/`);
    await expect(page.getByText('Recovery needs inspection · 1', { exact: true })).toBeVisible();
    for (const task of tasks.slice(1)) await expect(page.locator(`a[href="/ui/tasks/${task.id}"]`)).toBeVisible();
    await expect(page.getByText('3 / 3 task slots in use · 0 queued · 3 / 3 operations running', { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    const shots = join(process.cwd(), 'test-results/ui-screenshots'); await mkdir(shots, { recursive: true });
    await page.screenshot({ path: join(shots, 'parallel-tasks-overview.png'), fullPage: true });
    await page.goto(`${origin}/ui/tasks/${held.id}`);
    await expect(page.getByText('Recovery needs inspection', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Preview task compaction' })).toBeDisabled();
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await runner.stop(); await f.cleanup();
  }
});
