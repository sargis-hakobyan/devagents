import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sharedPort } from './playwright.config.js';

const base = `http://127.0.0.1:${sharedPort}`;
test('shared password login supports keyboard entry, failures, reload and sign-out on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/ui/`);
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByText('devagents ui', { exact: true })).toHaveCount(0);
  const username = page.getByLabel('Username', { exact: true }); const password = page.getByLabel('Password', { exact: true });
  await username.fill('admin'); await password.fill('incorrect'); await password.press('Enter');
  await expect(page.getByRole('alert')).toHaveText('Username or password is incorrect');
  await expect(username).toHaveValue('admin'); await expect(password).toHaveValue('');
  const shots = join(import.meta.dirname, '..', '..', 'test-results', 'ui-screenshots'); await mkdir(shots, { recursive: true });
  await page.screenshot({ path: join(shots, 'password-login-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await password.fill('admin'); await password.press('Enter');
  await expect(page).toHaveURL(`${base}/ui/`);
  await expect(page.getByRole('heading', { name: 'Workspace', exact: true })).toBeVisible();
  await expect(page.locator('.brand-ctx')).toContainText('Administrator');
  await page.reload(); await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  expect((await page.request.get(`${base}/tasks`)).status()).toBe(401);
  await page.reload(); await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
});
