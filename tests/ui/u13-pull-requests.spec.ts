import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureDir, port } from './playwright.config.js';

// The fixture's GitHub is a local bare repository and canned answers; this token is made up.
const GITHUB = `github_pat_${'fixture0'.repeat(4)}`;

test('a connected project turns on Publish, and a finished task is opened as a pull request with a click', async ({ page }) => {
  const base = `http://127.0.0.1:${port}`;
  const bearer = (await readFile(join(fixtureDir, 'api-token'), 'utf8')).trim();
  const headers = { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' };
  const call = (path: string, method: string, body?: unknown) => fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  expect((await call('/projects/fixture/integrations/github', 'PUT', { token: GITHUB, repository: 'example-org/website' })).status).toBe(200);
  const tasks = await (await call('/tasks?limit=50', 'GET')).json() as { tasks: { id: string; state: string; request: string }[] };
  const done = tasks.tasks.find(t => t.state === 'completed' && t.request.startsWith('Implement three modules'))!;
  const link = await (await call('/ui/bootstrap', 'POST', {})).json() as { url: string };
  try {
    await page.goto(link.url); await page.goto(`${base}/ui/tasks/${done.id}`);
    await expect(page.getByRole('tab', { name: 'Result' })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Pull request/ })).toHaveCount(0);

    await page.goto(`${base}/ui/projects/fixture`);
    const publish = page.getByRole('group', { name: 'Publish' });
    await expect(publish.getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByLabel('Target branch')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
    await publish.getByRole('button', { name: 'Ask me' }).click();
    await expect(page.getByLabel('Target branch').locator('option')).toHaveText(['Default branch (main)', 'main', 'develop']);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
    await expect(publish.getByRole('button', { name: 'Ask me' })).toHaveAttribute('aria-pressed', 'true');

    await page.goto(`${base}/ui/tasks/${done.id}`);
    await page.getByRole('tab', { name: 'Pull request' }).click();
    await page.getByRole('button', { name: 'Open pull request' }).click();
    await expect(page.getByRole('tab', { name: /Pull request · #\d+/ })).toBeVisible();
    // Within moments the fixture's GitHub is read: the failed check and the comments appear, and the task moves on the board.
    await expect(page.getByText('1 check failed').first()).toBeVisible({ timeout: 20000 });
    const checks = page.locator('section', { hasText: 'GitHub checks' }).last(); const comments = page.locator('section', { hasText: 'GitHub review comments' }).last();
    await expect(checks).toContainText('test (node 24)'); await expect(checks).toContainText('Failed · 1 failed, 23 passed'); await expect(checks).toContainText('1 failed · 1 passed');
    await expect(comments).toContainText('@reviewer-a'); await expect(comments).toContainText('1 open');
    await expect(comments.locator('li', { hasText: '@outside-user' })).toContainText('Does not count');
    await expect(page.getByRole('link', { name: 'View on GitHub' })).toHaveAttribute('href', /^https:\/\/github\.com\/example-org\/website\/pull\/\d+$/);
    await expect(page.getByText(/^PR #\d+ · 1 check failed$/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open pull request' })).toHaveCount(0);
    await page.goto(`${base}/ui/tasks`);
    const column = page.getByRole('region', { name: /^Pull request, 1 task/ });
    await expect(column).toContainText('Implement three modules'); await expect(column).toContainText('1 check failed');
    await expect(page.getByRole('region', { name: /^Done,/ })).not.toContainText('Implement three modules');
  } finally {
    await call('/projects/fixture/pull-requests', 'PUT', { publish: 'off' });
    await call('/projects/fixture/integrations/github', 'DELETE');
  }
});
