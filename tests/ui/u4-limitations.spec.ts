import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureDir, port } from './playwright.config.js';
const base = `http://127.0.0.1:${port}`;
async function call(path: string, method = 'GET', body?: unknown, headers = {}) {
  return fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${(await readFile(join(fixtureDir, 'api-token'), 'utf8')).trim()}`, 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function signIn(page: Page) { const { url } = await (await call('/ui/bootstrap', 'POST', {})).json(); await page.goto(url); await expect(page).toHaveURL(`${base}/ui/`); }

test('a check that could not run is reported with a completed task, not retried', async ({ page }) => {
  await signIn(page);
  const held = (await (await call('/tasks?limit=200')).json()).tasks.find((t: { request: string; state: string }) => t.request.includes('Long-running') && t.state === 'running');
  if (held) await call(`/tasks/${held.id}/cancel`, 'POST', {});
  const task = await (await call('/tasks', 'POST', { projectId: 'fixture', request: 'Fix the greeting and verify it visually [blocked-check]', mode: 'autonomous' }, { 'idempotency-key': crypto.randomUUID() })).json();
  await expect.poll(async () => (await (await call(`/tasks/${task.id}`)).json()).state, { timeout: 30000 }).toBe('completed');
  const done = await (await call(`/tasks/${task.id}`)).json();
  expect(done.outcome.repairCycles).toBe(0); expect(done.outcome.limitations).toHaveLength(1);
  await page.goto(`${base}/ui/tasks/${task.id}`);
  await expect(page.getByText('Completed with 1 check not run in this environment', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Result', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Checks not run in this environment' })).toContainText('no browser is available in this sandbox');
  await page.goto(`${base}/ui/tasks`);
  await expect(page.locator('tr', { hasText: '[blocked-check]' })).toContainText('1 check not run here');
});
