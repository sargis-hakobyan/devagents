import { test, expect } from '@playwright/test';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fixtureDir, port } from './playwright.config.js';

test('a project is archived and restored from the browser; open work blocks it and history stays', async ({ page }) => {
  const base = `http://127.0.0.1:${port}`;
  const bearer = (await readFile(join(fixtureDir, 'api-token'), 'utf8')).trim();
  const headers = { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' };
  const repo = await mkdtemp(join(tmpdir(), 'devagents-archive-spec-'));
  execFileSync('git', ['init', '-q', '-b', 'main', repo]); await writeFile(join(repo, 'README.md'), '# Archive spec\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Initial']);
  const name = `Archive spec ${Date.now().toString(36)}`;
  const created = await fetch(`${base}/projects`, { method: 'POST', headers, body: JSON.stringify({ name, path: repo }) });
  expect(created.status).toBe(201);
  const id = (await created.json() as { id: string }).id;
  const task = await (await fetch(`${base}/tasks`, { method: 'POST', headers: { ...headers, 'idempotency-key': id }, body: JSON.stringify({ projectId: id, request: 'Keep this in the history' }) })).json() as { id: string };
  const link = await (await fetch(`${base}/ui/bootstrap`, { method: 'POST', headers, body: '{}' })).json() as { url: string };
  await page.goto(link.url);
  try {
    await page.goto(`${base}/ui/projects/${id}`);
    await page.getByRole('button', { name: 'Archive project…' }).click();
    const confirm = page.getByRole('group', { name: `Archive ${name}?` });
    await expect(confirm).toContainText('Kept:'); await expect(confirm).toContainText('Removed:');
    await confirm.getByRole('button', { name: `Yes, archive ${name}` }).click();
    await expect(page.getByRole('alert')).toContainText('Finish or cancel the 1 open task of this project');
    await fetch(`${base}/tasks/${task.id}/cancel`, { method: 'POST', headers, body: '{}' });
    await confirm.getByRole('button', { name: `Yes, archive ${name}` }).click();
    await expect(page.getByText('This project is archived')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Integrations' })).toHaveCount(0);

    // Gone from the active list and the submit form; listed as archived; its task is still there and marked.
    await page.goto(`${base}/ui/projects`);
    await expect(page.locator('article', { hasText: name })).toHaveCount(0);
    await expect(page.getByText(/Archived projects · \d+/)).toBeVisible();
    await expect(page.getByRole('link', { name })).toBeVisible();
    await page.goto(`${base}/ui/tasks/new`);
    await expect(page.getByLabel('Project').locator('option', { hasText: name })).toHaveCount(0);
    await page.goto(`${base}/ui/tasks/${task.id}`);
    await expect(page.getByText('Keep this in the history').first()).toBeVisible();
    await expect(page.getByText('Archived project')).toBeVisible();
    await page.screenshot({ path: join(process.cwd(), 'test-results', 'ui-screenshots', 'u9-archived-task.png'), fullPage: true });

    // Restore from the archived list.
    await page.goto(`${base}/ui/projects`);
    await page.screenshot({ path: join(process.cwd(), 'test-results', 'ui-screenshots', 'u9-archived-projects.png'), fullPage: true });
    await page.getByRole('button', { name: `Restore ${name}` }).click();
    await expect(page.locator('article', { hasText: name })).toHaveCount(1);

    // Rename: the name changes everywhere, the ID and the task do not.
    await page.goto(`${base}/ui/projects/${id}`);
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
    await expect(page.getByText(id, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Rename' }).click();
    await page.getByLabel('Project name').fill('website');
    await page.getByRole('button', { name: 'Save name' }).click();
    await expect(page.getByRole('alert')).toContainText('already named "website"');
    const renamed = `${name} renamed`;
    await page.getByLabel('Project name').fill(renamed);
    await page.getByRole('button', { name: 'Save name' }).click();
    await expect(page.getByRole('heading', { level: 1, name: renamed })).toBeVisible();
    await page.screenshot({ path: join(process.cwd(), 'test-results', 'ui-screenshots', 'u9-project-renamed.png'), fullPage: true });
    await page.goto(`${base}/ui/tasks/${task.id}`);
    await expect(page.getByRole('link', { name: renamed })).toHaveAttribute('href', `/ui/projects/${id}`);
    await page.goto(`${base}/ui/tasks`);
    await expect(page.getByRole('cell', { name: renamed }).first()).toBeVisible();
    const restored = (await (await fetch(`${base}/projects`, { headers })).json() as { id: string; archivedAt?: string }[]).find(p => p.id === id);
    expect(restored).toBeTruthy(); expect(restored!.archivedAt).toBeUndefined();
  } finally {
    // Leave the fixture as other specs expect it: this throwaway project ends archived.
    const project = (await (await fetch(`${base}/projects?filter=all`, { headers })).json() as { id: string; version: number; archivedAt?: string }[]).find(p => p.id === id);
    if (project && !project.archivedAt) await fetch(`${base}/projects/${id}/archive`, { method: 'POST', headers, body: JSON.stringify({ archived: true, expectedVersion: project.version }) });
    await rm(repo, { recursive: true, force: true });
  }
});
