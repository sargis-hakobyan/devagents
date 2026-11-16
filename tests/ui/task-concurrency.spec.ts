import { test, expect } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureDir, port } from './playwright.config.js';

test('Settings saves task capacity, validates limits and shows failed saves on desktop and mobile', async ({ page }) => {
  const base = `http://127.0.0.1:${port}`;
  const token = (await readFile(join(fixtureDir, 'api-token'), 'utf8')).trim();
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const original = await (await fetch(`${base}/settings/task-concurrency`, { headers })).json() as { maxConcurrentTasks: number; version: number };
  const link = await (await fetch(`${base}/ui/bootstrap`, { method: 'POST', headers, body: '{}' })).json() as { url: string };
  await page.goto(link.url); await page.goto(`${base}/ui/settings`);
  const input = page.getByLabel('Maximum concurrent tasks (1–8)');
  const save = page.getByRole('button', { name: 'Save task concurrency' });
  try {
    await expect(input).toHaveValue(String(original.maxConcurrentTasks));
    await input.fill('9'); await expect(save).toBeDisabled();
    await input.fill('2'); await save.click();
    await expect(page.getByRole('status')).toContainText('Task concurrency saved');
    await page.reload(); await expect(input).toHaveValue('2');
    expect((await (await fetch(`${base}/scheduler`, { headers })).json()).maxConcurrentTasks).toBe(2);
    const shots = join(process.cwd(), 'test-results', 'ui-screenshots'); await mkdir(shots, { recursive: true });
    await page.screenshot({ path: join(shots, 'task-concurrency-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 }); await input.scrollIntoViewIfNeeded();
    await expect(input).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.route('**/settings/task-concurrency', async route => {
      if (route.request().method() === 'PUT') await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'stale_settings', message: 'Task concurrency changed; reload before saving again' }) });
      else await route.continue();
    });
    await input.fill('3'); await save.click();
    await expect(page.getByRole('alert')).toContainText('Task concurrency changed');
    await page.screenshot({ path: join(shots, 'task-concurrency-mobile.png'), fullPage: true });
  } finally {
    const current = await (await fetch(`${base}/settings/task-concurrency`, { headers })).json() as { version: number };
    await fetch(`${base}/settings/task-concurrency`, { method: 'PUT', headers, body: JSON.stringify({ maxConcurrentTasks: original.maxConcurrentTasks, expectedVersion: current.version }) });
  }
});
