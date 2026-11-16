import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureDir, port } from './playwright.config.js';

test('ready tasks with a scheduler slot show preparation instead of a false queue message', async ({ page }) => {
  const base = `http://127.0.0.1:${port}`;
  const token = (await readFile(join(fixtureDir, 'api-token'), 'utf8')).trim();
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const list = await (await fetch(`${base}/tasks`, { headers })).json() as { tasks: { id: string; state: string }[] };
  const id = list.tasks.find(t => t.state === 'running')!.id;
  const link = await (await fetch(`${base}/ui/bootstrap`, { method: 'POST', headers, body: '{}' })).json() as { url: string };
  let status = 'running'; let reason = 'Task execution is active';
  await page.route(`${base}/tasks/${id}`, async route => {
    const response = await route.fetch(); const task = await response.json();
    await route.fulfill({ response, json: { ...task, state: 'ready', scheduling: { status, reason } } });
  });
  await page.goto(link.url); await page.goto(`${base}/ui/tasks/${id}`);
  await expect(page.locator('.chip').filter({ hasText: 'Preparing execution' })).toBeVisible();
  await expect(page.getByText('Task execution is active', { exact: true })).toBeVisible();
  await expect(page.getByText('This task starts when the scheduler has capacity.')).toHaveCount(0);
  reason = 'Execution is waiting for shared operation or preparation capacity';
  await expect(page.getByText(reason, { exact: true })).toBeVisible();
  status = 'queued'; reason = 'Waiting for an available task slot';
  await expect(page.getByText('Queued for execution', { exact: true })).toBeVisible();
  await expect(page.getByText(reason, { exact: true })).toBeVisible();
  await expect(page.locator('.chip').filter({ hasText: /^…Queued$/ })).toBeVisible();
});
