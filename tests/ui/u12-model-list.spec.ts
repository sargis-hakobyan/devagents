import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureDir, port } from './playwright.config.js';

const base = `http://127.0.0.1:${port}`;
async function bearer(): Promise<string> { return (await readFile(join(fixtureDir, 'api-token'), 'utf8')).trim(); }
async function signIn(page: Page): Promise<void> {
  const link = await (await fetch(`${base}/ui/bootstrap`, { method: 'POST', headers: { authorization: `Bearer ${await bearer()}`, 'content-type': 'application/json' }, body: '{}' })).json() as { url: string };
  await page.goto(link.url);
  await expect(page).toHaveURL(`${base}/ui/`);
}

test('the model list is the built-in one until Refresh list loads it from the engine, and a failed load keeps what was shown', async ({ page }) => {
  await signIn(page);
  const asked: string[] = [];
  page.on('request', r => { if (r.url().includes('/teams/models/refresh')) asked.push(r.method()); });
  await page.goto(`${base}/ui/teams`);
  await page.getByRole('link', { name: 'Edit' }).first().click();
  await page.locator('ul.members button').first().click();
  const model = page.getByRole('combobox', { name: 'Model', exact: true });
  const hint = page.locator('.field .hint').filter({ hasText: 'account access is not verified' });
  await expect(hint).toContainText('Built-in list from 3 Nov 2026');
  await expect(model.locator('option', { hasText: 'gpt-6-luna' })).toHaveCount(1);
  expect(asked, 'opening the editor asks no engine').toEqual([]);

  await page.getByRole('button', { name: 'Refresh list' }).click();
  await expect(hint).toContainText('List loaded from Codex');
  await expect(model.locator('option', { hasText: 'gpt-6-luna' })).toHaveCount(0);
  await expect(model.locator('option', { hasText: 'GPT-6.1 Terra · gpt-6.1-terra' })).toHaveCount(1);
  await expect(model.locator('option', { hasText: '· new' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Refresh list' }).click();
  await expect(model.locator('option', { hasText: 'GPT Fixture Next · gpt-fixture-next · new' })).toHaveCount(1);
  await model.selectOption('gpt-fixture-next');
  await expect(hint).toContainText('Resolved: gpt-fixture-next');

  await page.reload();
  await page.locator('ul.members button').first().click();
  await expect(hint).toContainText('List loaded from Codex');

  await page.getByRole('combobox', { name: /^Engine/ }).selectOption('claude-code');
  await expect(hint).toContainText('Built-in list from 3 Nov 2026');
  await page.getByRole('button', { name: 'Refresh list' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Could not load models from claude-code' })).toContainText('Showing the built-in list.');
  await expect(model.locator('option', { hasText: 'claude-sonnet-5-5' })).toHaveCount(1);
});
