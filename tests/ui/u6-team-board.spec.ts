import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureDir, port } from './playwright.config.js';
const base = `http://127.0.0.1:${port}`;
async function call(path: string, method = 'GET', body?: unknown, headers = {}) {
  return fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${(await readFile(join(fixtureDir, 'api-token'), 'utf8')).trim()}`, 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function signIn(page: Page) { const { url } = await (await call('/ui/bootstrap', 'POST', {})).json(); await page.goto(url); await expect(page).toHaveURL(`${base}/ui/`); }
type Row = { id: string; request: string; state: string };
const find = async (text: string) => ((await (await call('/tasks?limit=200')).json()).tasks as Row[]).find(t => t.request.startsWith(text))!;
const stages = (page: Page) => page.locator('.pipe > li .h');

test('a completed multi-item task shows six finished stages including QA and the final commit', async ({ page }) => {
  await signIn(page); const task = await find('Implement three modules');
  await page.goto(`${base}/ui/tasks/${task.id}`);
  const pipeline = page.getByRole('region', { name: 'Your team on this task' });
  await expect(stages(page)).toHaveText(['1 · Plan', '2 · Build', '3 · Integrate', '4 · QA', '5 · Review', '6 · Commit']);
  await expect(pipeline.locator('.stagecol .stage', { hasText: '✓ Done' })).toHaveCount(5);
  await expect(pipeline.locator('[data-stage="build"] .member')).toHaveCount(3);
  await expect(pipeline.locator('[data-member="devagents"]')).toContainText('Committed ');
  await expect(pipeline.locator('[data-stage="qa"]')).toContainText('✓ Passed');
  await page.getByText('Planned responsibilities and work items', { exact: true }).click();
  const list = page.getByRole('region', { name: 'Planned responsibilities', exact: true });
  await expect(list.getByRole('heading', { level: 2 })).toHaveText('Planned responsibilities');
  await expect(list.locator('.workflow-step-heading h3')).toHaveText(['1. Planning', '2. Implementation', '3. Integration', '4. Quality assurance', '5. Review', '6. Commit']);
  await expect(list.locator('article[data-status="done"]')).toHaveCount(8); // QA and integration each have their own stage
  await expect(list.locator('article[data-member="backend-developer"]')).toContainText('Tests ✓');
  await expect(list.locator('article[data-member="backend-developer"]')).toContainText('Integrated');
  await expect(list.locator('article[data-member="qa-engineer"]')).toHaveAttribute('data-status', 'done');
  await expect(page.locator('.stackbtn')).toHaveCount(0); // a finished task lists everyone; no stacks
});

test('a single-item task has five stages including QA and no integration step; the activity link filters the Activity tab to that item', async ({ page }) => {
  await signIn(page); const task = await find('Fix the greeting so the existing test passes');
  await page.goto(`${base}/ui/tasks/${task.id}`);
  await expect(stages(page)).toHaveText(['1 · Plan', '2 · Build', '3 · QA', '4 · Review', '5 · Commit']);
  await expect(page.locator('[data-stage="review"] .member')).toContainText('Code Reviewer');
  await page.getByText('Planned responsibilities and work items', { exact: true }).click();
  const detail = page.locator('[data-workflow-stage="build"]');
  await expect(detail.locator('.work-item-title')).toHaveText('Fix greeting');
  await expect(detail).toContainText('Prerequisites: approved plan');
  await expect(detail.locator('.scope-paths')).not.toBeVisible();
  await detail.getByText('Technical details', { exact: true }).click();
  await expect(detail.locator('.scope-paths')).toBeVisible();
  await page.getByRole('button', { name: 'Show activity for fix' }).click();
  await expect(page.getByRole('tab', { name: 'Activity', exact: false })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.card-head')).toContainText('Activity · item fix');
  await expect(page.locator('.timeline li')).not.toHaveCount(0);
  await expect(page.locator('.timeline li', { hasText: 'Task submitted' })).toHaveCount(0); // events that do not name the item are hidden
  await page.getByRole('button', { name: 'Show all' }).click();
  await expect(page.locator('.card-head')).not.toContainText('item fix');
});

test('while a plan awaits approval, "You" is a member with the decision and everyone else waits', async ({ page }) => {
  await signIn(page); const task = await find('Add input validation to the API');
  expect(task.state).toBe('awaiting_plan_approval');
  await page.goto(`${base}/ui/tasks/${task.id}`);
  const plan = page.locator('[data-stage="plan"]');
  await expect(plan).toContainText('● Needs you');
  await expect(plan.locator('[data-member="you"]')).toContainText(`Approve plan version `);
  await expect(page.locator('[data-stage="build"] .member')).toContainText('Starts after your decision');
  await page.getByText('Planned responsibilities and work items', { exact: true }).click();
  await expect(page.locator('[data-workflow-stage="plan"] [data-member="you"]')).toBeVisible();
  await expect(page.locator('[data-workflow-stage]').first()).toHaveAttribute('data-workflow-stage', 'plan');
});

test('a failed task names the stopped member, the sibling that never ran and the review and commit that were not reached', async ({ page }) => {
  await signIn(page); const task = await find('Combine both edits [fail-review]');
  expect(task.state).toBe('failed');
  await page.goto(`${base}/ui/tasks/${task.id}`);
  await expect(page.locator('[data-stage="build"] .stage').first()).toContainText('✕ 1 stopped');
  await expect(page.locator('[data-stage="build"] [data-status="fail"]')).toHaveCount(1);
  await expect(page.locator('[data-stage="review"] .member')).toContainText('not reached');
  await expect(page.locator('[data-member="devagents"]').first()).toContainText('No commit');
});

test('the team board stacks at 390 px without horizontal scrolling and renders hostile text as text', async ({ page }) => {
  await signIn(page); const hostile = await find('Add a <script>');
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`${base}/ui/tasks/${hostile.id}`);
  await expect(page.locator('.pipeline')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.querySelectorAll('script[src="x"], img[src="x"], iframe').length)).toBe(0);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('<script>');
  await expect(page.getByRole('region', { name: 'Execution workflow' }).locator('article')).not.toHaveCount(0);
});
