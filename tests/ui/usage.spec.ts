import { test, expect } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { fixture } from '../helpers.js';
import { createApi } from '../../src/api/server.js';
import { fixtureDir, port } from './playwright.config.js';

test('usage displays separate repair attempts, honest costs, currency conversion and narrow layout', async ({ page }) => {
  const f = await fixture();
  const fixtureToken = (await readFile(join(fixtureDir, 'api-token'), 'utf8')).trim();
  const status = await (await fetch(`http://127.0.0.1:${port}/status`, { headers: { authorization: `Bearer ${fixtureToken}` } })).json();
  const server = createApi(f.service, 'synthetic-usage-token', { uiRoot: join(process.cwd(), 'dist/ui'), status: async () => status });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Usage and repair fixture', mode: 'autonomous' }, 'usage-browser');
    const price = { inputPerMillion: 2, cachedInputPerMillion: 0.5, outputPerMillion: 8, asOf: '2026-11-03' };
    for (const runId of ['first', 'repair']) {
      f.store.record(task.id, 'run-started', { runId, phase: 'implementation', agentId: 'developer', model: 'fixture-model', auth: 'login', providerKind: 'openai', usagePrice: price });
      f.store.record(task.id, 'progress', { runId, kind: 'started', data: { billing: 'subscription' } });
      f.store.record(task.id, 'progress', { runId, kind: 'usage', data: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 100 } });
      f.store.record(task.id, 'run-completed', { runId, usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 100 } });
    }
    f.store.record(task.id, 'run-started', { runId: 'unknown', phase: 'review', agentId: 'reviewer', model: 'default', auth: 'login', usagePrice: null });
    f.store.record(task.id, 'run-completed', { runId: 'unknown', usage: { input_tokens: 500, cached_input_tokens: 0, output_tokens: 200 } });
    f.store.record(task.id, 'run-started', { runId: 'missing', phase: 'setup', agentId: 'developer' });
    f.store.record(task.id, 'repository-scan', { state: 'retrying', attempt: 2, reason: 'Original checkout status scan timed out after 120 seconds; retrying once (attempt 2 of 2).' });
    f.service.cancel(task.id);
    const bootstrap = await fetch(`${origin}/ui/bootstrap`, { method: 'POST', headers: { authorization: 'Bearer synthetic-usage-token', 'content-type': 'application/json' }, body: '{}' });
    await page.goto((await bootstrap.json()).url);
    await page.goto(`${origin}/ui/tasks/${task.id}`); await page.getByRole('tab', { name: /^Activity/ }).click();
    await expect(page.getByText('Original checkout status scan timed out after 120 seconds; retrying once (attempt 2 of 2).', { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Usage', exact: true }).click();
    await expect(page.getByText('3 of 4 runs reported · 1 missing', { exact: true })).toBeVisible();
    await expect(page.locator('.usage-totals')).toContainText('2,900');
    await expect(page.locator('.usage-totals')).toContainText('$0.0032');
    await expect(page.locator('.usage-totals')).toContainText('Estimated API costUnavailable');
    await page.locator('.usage-step summary').filter({ hasText: 'Development' }).click();
    await expect(page.getByRole('region', { name: 'Development usage attempts' }).getByText('Attempt 2', { exact: true })).toBeVisible();
    await page.locator('.usage-step summary').filter({ hasText: 'Review' }).click();
    await expect(page.getByText('Runtime model was not recorded', { exact: true })).toBeVisible();
    await page.getByLabel('Usage currency').selectOption('EUR');
    await expect(page.locator('.usage-totals')).toContainText('Set exchange rate');
    await page.getByLabel('EUR per USD', { exact: true }).fill('0.9'); await page.getByLabel('Rate date').fill('2026-11-03');
    await expect(page.locator('.usage-totals')).toContainText('€0.0029');
    await expect(page.getByText('Conversion: 1 USD = 0.9 EUR · 2026-11-03')).toBeVisible();
    const shots = join(process.cwd(), 'test-results/ui-screenshots'); await mkdir(shots, { recursive: true });
    await page.screenshot({ path: join(shots, 'usage-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: join(shots, 'usage-mobile.png'), fullPage: true });
    await page.route(`${origin}/tasks/${task.id}/usage`, route => route.fulfill({ status: 500, json: { error: 'test_failure', message: 'Usage fixture unavailable' } }));
    await page.reload(); await page.getByRole('tab', { name: 'Usage', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Retry usage' })).toBeVisible();
    await page.unroute(`${origin}/tasks/${task.id}/usage`); await page.getByRole('button', { name: 'Retry usage' }).click();
    await expect(page.locator('.usage-totals')).toContainText('2,900');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.cleanup(); }
});
