import type { AddressInfo } from 'node:net';
import { createApi } from '../../src/api/server.js';
import { Config } from '../../src/domain/schemas.js';
import { TaskService } from '../../src/orchestration/service.js';
import { fixture as diffFixture } from '../helpers.js';
import { WorkspaceManager, git } from '../../src/workspace/git.js';
import { Store } from '../../src/persistence/store.js';
import { test, expect, type Page } from '@playwright/test';
import { readFile, realpath, mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureDir, port } from './playwright.config.js';
const base = `http://127.0.0.1:${port}`;
const shots = join(import.meta.dirname, '..', '..', 'test-results', 'ui-screenshots');
async function call(path: string, method = 'GET', body?: unknown, headers = {}) {
  return fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${(await readFile(join(fixtureDir, 'api-token'), 'utf8')).trim()}`, 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function signIn(page: Page) { const { url } = await (await call('/ui/bootstrap', 'POST', {})).json(); await page.goto(url); await expect(page).toHaveURL(`${base}/ui/`); }
let root: string;
test.beforeAll(async () => {
  await mkdir(shots, { recursive: true }); root = await mkdtemp(join(tmpdir(), 'devagents-u3-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  await writeFile(join(root, 'greeting.cjs'), "module.exports=()=> 'broken';\n");
  await writeFile(join(root, 'greeting.test.cjs'), "const test=require('node:test'),assert=require('node:assert/strict');test('greeting',()=>assert.equal(require('./greeting.cjs')(),'hello'));\n");
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Initial']);
});
test.afterAll(async () => { await rm(root, { recursive: true, force: true }); });

test('registration validation explains disabled submit; a project is given a name, never an ID', async ({ page }) => {
  await page.route(/\/status$/, async route => {
    const response = await route.fetch(); const status = await response.json();
    await route.fulfill({ response, json: { ...status, service: { ...status.service, dataDir: '/data' } } });
  });
  await signIn(page); await page.goto(`${base}/ui/projects/new`);
  const name = page.getByLabel('Project name', { exact: true });
  await expect(page.getByLabel('Project ID')).toHaveCount(0);
  await page.getByRole('radio', { name: 'Already mounted in Docker (advanced)' }).check();
  const path = page.getByLabel('Repository path inside Docker');
  const submit = page.getByRole('button', { name: 'Register project', exact: true });
  await expect(submit).toBeDisabled();
  await expect(submit).toHaveAccessibleDescription('Enter a project name and an absolute path to enable registration.');
  await name.focus(); await name.press('Tab');
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await expect(name).toHaveAccessibleDescription(/Enter a project name/);
  await name.fill('   '); await expect(name).toHaveAccessibleDescription(/Enter a project name/);
  await name.fill('My Project · Café'); await path.fill('~/Projects/my-project');
  await expect(name).not.toHaveAttribute('aria-invalid', 'true');
  await expect(name).toHaveAccessibleDescription(/you can change it later/);
  await expect(path).toHaveAccessibleDescription(/Expand ~/);
  await expect(submit).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(shots, 'registration-validation-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await name.fill('A'.repeat(80));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await name.fill('My Project');
  await path.fill('projects/my-project'); await expect(path).toHaveAccessibleDescription(/must start with/);
  await path.fill('/projects/../my-project'); await expect(path).toHaveAccessibleDescription(/without \.\. segments/);
  await path.fill('/'); await expect(path).toHaveAccessibleDescription(/not the filesystem root/);
  await path.fill('/Users/example/Projects/my-project');
  await expect(path).toHaveAccessibleDescription(/Docker can only use it if it is mounted/);
  await expect(page.getByRole('radio', { name: 'Folder on my computer (recommended)' })).toBeVisible();
  // Host-looking paths are a contextual hint, not a claim that the mount was checked.
  await expect(submit).toBeEnabled();
  await path.fill('/projects/my project'); await expect(submit).toBeEnabled();
  await expect(submit).toHaveAccessibleDescription(/service will check the folder/);
  await path.fill(''); await expect(submit).toBeDisabled();
  await expect(submit).toHaveAccessibleDescription('Enter an absolute path to enable registration.');
});

test('Docker registration accepts a host folder and prepares a literal launcher command without registering early', async ({ page }) => {
  await page.route(/\/status$/, async route => {
    const response = await route.fetch(); const status = await response.json();
    await route.fulfill({ response, json: { ...status, service: { ...status.service, dataDir: '/data' } } });
  });
  let posts = 0;
  page.on('request', r => { if (r.method() === 'POST' && r.url() === `${base}/projects`) posts++; });
  await signIn(page); await page.goto(`${base}/ui/projects/new`);
  await expect(page.getByRole('radio', { name: 'Folder on my computer (recommended)' })).toBeChecked();
  await expect(page.getByLabel('Repository path inside Docker')).toHaveCount(0);
  const path = page.getByLabel('Repository folder on your computer');
  const prepare = page.getByRole('button', { name: 'Prepare setup command' });
  await expect(prepare).toBeDisabled();
  await page.getByLabel('Project name', { exact: true }).fill("Sam's Project");
  await path.fill('/Users/example/folder,with-comma');
  await expect(prepare).toBeDisabled();
  await expect(path).toHaveAccessibleDescription(/does not support commas/);
  const hostPath = "/Users/example/Project's folder/$(printf INJECTED)`printf INJECTED`";
  await path.fill(hostPath); await prepare.click();
  await expect(page.getByRole('status').filter({ hasText: 'project not registered yet' })).toBeVisible();
  const command = (await page.locator('.command pre').textContent())!;
  // Evaluate only the argument quoting using printf, never launch Docker or touch this synthetic folder.
  const args = execFileSync('/bin/sh', ['-c', command.replace('./devagents', "printf '%s\\n'")], { encoding: 'utf8' }).trimEnd().split('\n');
  expect(args).toEqual(['project', 'add', '--name', "Sam's Project", '--path', hostPath]);
  expect(posts).toBe(0);
  await page.getByText('How the folder will be connected', { exact: true }).click();
  await expect(page.getByText('/projects/<generated project ID>', { exact: true })).toBeVisible();
  await path.fill('/Users/example/Projects/my-project'); await prepare.click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: join(shots, 'registration-host-path-mobile.png'), fullPage: true });
  await path.fill('/Users/example/other');
  await expect(page.locator('.command pre')).toHaveCount(0);
  await page.getByRole('radio', { name: 'Already mounted in Docker (advanced)' }).check();
  await expect(page.getByLabel('Repository path inside Docker')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Register project', exact: true })).toBeDisabled();
});

test('registration preserves input on backend refusal and registers an existing checkout', async ({ page }) => {
  await signIn(page); await page.goto(`${base}/ui/projects/new`);
  await page.getByLabel('Project name', { exact: true }).fill('Browser project');
  await page.getByLabel('Absolute path as the service sees it').fill('/projects/not-mounted');
  await page.getByRole('button', { name: 'Register project', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('mount the checkout and register its container path');
  await expect(page.getByLabel('Project name', { exact: true })).toHaveValue('Browser project');
  await expect(page.getByLabel('Absolute path as the service sees it')).toHaveValue('/projects/not-mounted');
  await page.screenshot({ path: join(shots, 'u3-register-error.png'), fullPage: true });
  await page.getByLabel('Absolute path as the service sees it').fill(root);
  await page.getByRole('button', { name: 'Register project', exact: true }).click();
  await expect(page.getByText('Repository registered', { exact: true })).toBeVisible();
  const registered = (await (await call('/projects')).json()).find((p: { name: string }) => p.name === 'Browser project') as { id: string; path: string };
  expect(registered.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  await expect(page.getByRole('link', { name: 'Submit work' })).toHaveAttribute('href', `/ui/tasks/new?project=${registered.id}`);
  expect(registered.path).toBe(await realpath(root));
});

test('submission uses effective defaults, disables unavailable teams and shows the frozen response', async ({ page }) => {
  await signIn(page); await page.goto(`${base}/ui/tasks/new`);
  await page.getByLabel('Project', { exact: true }).selectOption('website');
  await expect(page.getByRole('radio', { name: /Use default/ })).toHaveAccessibleName(/plan-approval \(project\)/);
  await expect(page.getByLabel('Team', { exact: true }).locator('option', { hasText: /Design team/ })).toHaveJSProperty('disabled', true);
  await expect(page.getByLabel('Team', { exact: true }).locator('option', { hasText: /Old platform team/ })).toHaveJSProperty('disabled', true);
  await expect(page.getByLabel('Team', { exact: true }).locator('option').first()).toContainText('Project default · Website team');
  await page.getByLabel('Project', { exact: true }).selectOption('fixture');
  await page.getByLabel('What should the team do?').fill('Browser submission with frozen team');
  await expect(page.getByRole('button', { name: 'Add criterion' })).toHaveCount(0);
  await expect(page.getByText('Acceptance criteria', { exact: true })).toHaveCount(0);
  const teams = await (await call('/teams')).json(); const team = teams.find((t: { name: string }) => t.name === 'Website team');
  await page.getByLabel('Team', { exact: true }).selectOption(team.id);
  await page.screenshot({ path: join(shots, 'u3-submit.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: join(shots, 'u3-submit-narrow.png'), fullPage: true });
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.getByRole('button', { name: 'Submit task', exact: true }).click();
  await expect(page.getByText('Task accepted', { exact: true })).toBeVisible();
  await expect(page.getByText(`Website team · revision ${team.revision}`, { exact: true })).toBeVisible();
  const href = await page.getByRole('link', { name: 'Open task' }).getAttribute('href');
  const task = await (await call(href!.replace('/ui', ''))).json();
  expect(task.state).toBe('awaiting_mode'); expect(task.acceptanceCriteria).toEqual([]);
  await page.screenshot({ path: join(shots, 'u3-accepted.png'), fullPage: true });
});

test('a dropped response, reload and session renewal retain one immutable submission attempt', async ({ page }) => {
  await signIn(page); await page.goto(`${base}/ui/tasks/new`);
  await page.getByLabel('Project', { exact: true }).selectOption('fixture');
  const request = 'Lost browser response must not duplicate work';
  await page.getByLabel('What should the team do?').fill(request);
  const attempts: { key: string; payload: unknown }[] = [];
  await page.route(`${base}/tasks`, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    attempts.push({ key: route.request().headers()['idempotency-key']!, payload: route.request().postDataJSON() });
    if (attempts.length === 1) { await route.fetch(); await route.abort('connectionreset'); } else await route.continue();
  });
  await page.getByRole('button', { name: 'Submit task', exact: true }).evaluate((b: HTMLButtonElement) => { b.click(); b.click(); });
  await expect(page.getByRole('button', { name: 'Retry this attempt' })).toBeEnabled();
  expect(attempts).toHaveLength(1);
  const held = await page.evaluate(() => JSON.parse(sessionStorage.getItem('devagents.submission.v1')!));
  expect(Object.keys(held).sort()).toEqual(['at', 'key', 'payload']);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Retry this attempt' })).toBeEnabled();
  await expect(page.getByLabel('What should the team do?')).toBeDisabled();
  expect(attempts).toHaveLength(1);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(`${base}/ui/signed-out`);
  await signIn(page); await page.goto(`${base}/ui/tasks/new`);
  await expect(page.getByLabel('What should the team do?')).toHaveValue(request);
  await page.getByRole('button', { name: 'Retry this attempt' }).click();
  await expect(page.getByText('Task accepted', { exact: true })).toBeVisible();
  expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]);
  expect(await page.evaluate(() => sessionStorage.getItem('devagents.submission.v1'))).toBeNull();
  const tasks = (await (await call('/tasks?limit=200')).json()).tasks;
  expect(tasks.filter((t: { request: string }) => t.request === request)).toHaveLength(1);
  expect((await call('/tasks', 'POST', { ...(held.payload), request: 'Changed input' }, { 'idempotency-key': held.key })).status).toBe(409);
});

test('abandon is explicit and unavailable tab storage prevents sending', async ({ page }) => {
  await signIn(page); await page.goto(`${base}/ui/tasks/new`);
  await page.getByLabel('Project', { exact: true }).selectOption('fixture');
  await page.getByLabel('What should the team do?').fill('Ambiguous attempt to abandon');
  await page.route(`${base}/tasks`, route => route.request().method() === 'POST' ? route.abort() : route.continue());
  await page.getByRole('button', { name: 'Submit task', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry this attempt' })).toBeEnabled();
  await page.getByRole('button', { name: 'Abandon attempt…', exact: true }).click();
  await expect(page.getByText('The first task may exist in your task list.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Keep', exact: true }).click();
  expect(await page.evaluate(() => sessionStorage.getItem('devagents.submission.v1'))).not.toBeNull();
  await page.getByRole('button', { name: 'Abandon attempt…', exact: true }).click();
  await page.getByRole('button', { name: 'Abandon', exact: true }).click();
  await expect(page.getByLabel('What should the team do?')).toBeEnabled();
  expect(await page.evaluate(() => sessionStorage.getItem('devagents.submission.v1'))).toBeNull();
  await page.unroute(`${base}/tasks`);
  let posts = 0; page.on('request', r => { if (r.method() === 'POST' && r.url() === `${base}/tasks`) posts++; });
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error('storage denied'); }; });
  await page.getByRole('button', { name: 'Submit task', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('No request was sent'); expect(posts).toBe(0);
});

async function stopInitialHold(page: Page) {
  const held = (await (await call('/tasks?limit=200')).json()).tasks.find((t: { request: string; state: string }) => t.request.includes('Long-running') && t.state === 'running');
  if (held) {
    await page.goto(`${base}/ui/tasks/${held.id}`);
    await page.getByRole('button', { name: 'Cancel task…', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm cancellation' }).click();
    await expect(page.getByText('Cancelled by you', { exact: true }).first()).toBeVisible();
  }
}

test('browser workflow registers, submits, rejects stale approval, approves and inspects the completed diff', async ({ page }) => {
  await signIn(page); await stopInitialHold(page);
  const before = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const existing = (await (await call('/projects')).json()).find((p: { path: string }) => p.path === root || p.path === `/private${root}`);
  const projectId = existing?.id ?? 'workflow-project';
  if (!existing) {
    await page.goto(`${base}/ui/projects/new`); await page.getByLabel('Project ID', { exact: true }).fill(projectId);
    await page.getByLabel('Absolute path as the service sees it').fill(root); await page.getByRole('button', { name: 'Register project', exact: true }).click();
    await expect(page.getByText('Repository registered', { exact: true })).toBeVisible();
  }
  await page.goto(`${base}/ui/tasks/new?project=${projectId}`);
  await page.getByLabel('What should the team do?').fill('Fix greeting through the browser [u3-e2e]');
  const team = (await (await call('/teams')).json()).find((t: { name: string }) => t.name === 'Website team');
  await page.getByLabel('Team', { exact: true }).selectOption(team.id);
  await page.getByRole('radio', { name: 'Plan approval · wait for my approval', exact: true }).check();
  await page.getByRole('button', { name: 'Submit task', exact: true }).click();
  await page.getByRole('link', { name: 'Open task' }).click();
  const id = page.url().split('/').pop()!;
  const approve = page.getByRole('button', { name: /^Approve version/ }).first();
  await expect(approve).toBeEnabled();
  await page.getByRole('tab', { name: 'Plan', exact: true }).click();
  await expect(page.locator('.plan-lead')).toHaveText('Show the expected greeting to the user');
  await expect(page.getByText('Use automated tests to check that the greeting shows the expected message.')).toBeVisible();
  await expect(page.locator('.plan-facts').first()).toContainText('Developer');
  const technical = page.locator('.plan-details');
  await expect(technical).not.toHaveAttribute('open', '');
  await expect(technical.getByText('Return hello from greeting.cjs')).not.toBeVisible();
  await page.screenshot({ path: join(shots, 'u3-approval.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const planBounds = await page.locator('.stack.plan').boundingBox();
  const actionBounds = await page.locator('.plan-decision-bar').boundingBox();
  expect(actionBounds!.y).toBeGreaterThanOrEqual(planBounds!.y + planBounds!.height);
  await page.screenshot({ path: join(shots, 'u3-approval-narrow.png'), fullPage: true });
  await technical.locator('summary').click();
  await expect(technical.getByText('Return hello from greeting.cjs')).toBeVisible();
  await expect(technical.getByText('node --test greeting.test.cjs', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await technical.locator('summary').click();
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.getByRole('tab', { name: /^Work/ }).click();
  // A second writer changes the durable version after the page rendered, before POST arrives.
  await page.route(`${base}/tasks/${id}/approve`, async route => {
    const store = new Store(join(fixtureDir, 'devagents.db'), []);
    try { const t = store.task(id); store.checkpoint(id, t.version, {}, 'Fixture stale approval'); } finally { store.close(); }
    await route.continue();
  });
  await approve.click();
  await expect(page.getByRole('alert')).toContainText('Task changed; reload before retrying');
  await expect(approve).toBeDisabled();
  expect((await (await call(`/tasks/${id}`)).json()).state).toBe('awaiting_plan_approval');
  await page.unroute(`${base}/tasks/${id}/approve`);
  await page.getByRole('button', { name: 'Review updated plan' }).click();
  await expect(page.getByRole('tab', { name: 'Plan', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: /^Approve version/ }).last().click();
  await expect(page.getByText('Completed: one reviewed local commit on the task branch', { exact: true })).toBeVisible({ timeout: 20000 });
  await page.getByRole('tab', { name: 'Result', exact: true }).click();
  await expect(page.getByText('Read-only diff', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Selected file diff' })).toContainText("+module.exports = () => 'hello'");
  const done = await (await call(`/tasks/${id}`)).json();
  expect(done.team.id).toBe(team.id); expect(done.approval.status).toBe('approved');
  expect(done.outcome.commit).toMatch(/^[a-f0-9]{40}$/);
  const evidence = await (await call(`/tasks/${id}/evidence`)).json();
  expect(evidence.some((e: { kind: string; data: { exitCode?: number } }) => e.kind === 'validation' && e.data.exitCode === 0)).toBe(true);
  expect(execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' })).toBe(before);
  expect(execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
  await page.screenshot({ path: join(shots, 'u3-diff.png'), fullPage: true });
});

test('mode choice has no preselection, rejection cancels, and resubmission prefills only text', async ({ page }) => {
  await signIn(page); await stopInitialHold(page);
  const task = await (await call('/tasks', 'POST', { projectId: 'fixture', request: 'Choose then reject', acceptanceCriteria: ['Keep history'] }, { 'idempotency-key': crypto.randomUUID() })).json();
  await page.goto(`${base}/ui/tasks/${task.id}`);
  await expect(page.getByRole('button', { name: 'Choose plan approval' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Choose autonomous' })).toBeEnabled();
  await page.getByRole('button', { name: 'Choose plan approval' }).click();
  await expect(page.getByRole('button', { name: 'Reject plan · cancels the task' })).toBeEnabled();
  await page.getByRole('button', { name: 'Reject plan · cancels the task' }).click();
  await page.getByRole('button', { name: 'Reject and cancel', exact: true }).click();
  await expect(page.getByText('Cancelled by you', { exact: true }).first()).toBeVisible();
  await page.getByRole('tab', { name: 'Result', exact: true }).click();
  await expect(page.getByText('Diff inspection is offered for completed tasks only.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Clean up worktrees/ })).toBeDisabled();
  await page.getByRole('link', { name: 'Submit a new task from this request' }).click();
  await expect(page.getByLabel('What should the team do?')).toHaveValue('Choose then reject');
  await expect(page.getByLabel('Criterion 1', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Project', { exact: true })).toHaveValue('');
  expect(await page.evaluate(() => sessionStorage.getItem('devagents.submission.v1'))).toBeNull();
});

test('locked or unavailable setup keeps terminal recovery and makes no automatic auth or model calls', async ({ page }) => {
  await signIn(page);
  const posts: string[] = []; page.on('request', r => { if (r.method() === 'POST') posts.push(r.url()); });
  await page.route(`${base}/status`, async route => {
    const response = await route.fetch(); const status = await response.json();
    await route.fulfill({ response, json: { ...status, codex: { ...status.codex, installed: false, signedIn: false, vaultLocked: true } } });
  });
  await page.goto(`${base}/ui/settings/setup`);
  await expect(page.getByRole('heading', { name: 'Get ready to run work' })).toBeVisible();
  const codex = page.locator('section.card').filter({ has: page.getByText('1 · Connect Codex', { exact: true }) });
  const claude = page.locator('section.card').filter({ has: page.getByText('Connect Claude', { exact: true }) });
  for (const connection of [codex, claude]) {
    await expect(connection.getByText('Credentials locked', { exact: true })).toBeVisible();
    await expect(connection.getByText('✕ Not installed ·', { exact: true })).toBeVisible();
    await expect(connection.getByRole('button', { name: /Use an .* API key/ })).toBeDisabled();
    await connection.getByText('Continue in your terminal', { exact: true }).click();
  }
  await expect(page.getByText('npm run cli -- auth setup', { exact: true })).toBeVisible();
  await expect(claude.getByText('docker compose exec devagents node dist/cli/main.js auth claude --method api-key', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Test connection · terminal only' })).toBeDisabled();
  await expect(page.locator('input')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: join(shots, 'u3-setup-narrow.png'), fullPage: true });
  await page.getByRole('link', { name: 'Submit work', exact: true }).click();
  await expect(page.getByLabel('What should the team do?')).toBeEnabled();
  expect(posts).toEqual([]);
});

test('queued and running cancellation work and the committing boundary offers no cancel', async ({ page }) => {
  await signIn(page); await stopInitialHold(page);
  const running = await (await call('/tasks', 'POST', { projectId: 'fixture', request: 'U3 running cancellation [hold]', mode: 'autonomous' }, { 'idempotency-key': crypto.randomUUID() })).json();
  try {
    await expect.poll(async () => (await (await call(`/tasks/${running.id}`)).json()).state).toBe('running');
    const queued = await (await call('/tasks', 'POST', { projectId: 'fixture', request: 'U3 queued cancellation', mode: 'autonomous' }, { 'idempotency-key': crypto.randomUUID() })).json();
    await page.goto(`${base}/ui/tasks/${queued.id}`);
    await page.getByRole('button', { name: 'Cancel task…', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm cancellation' }).click();
    await expect(page.getByText('Cancelled by you', { exact: true }).first()).toBeVisible();
    // The real committing refusal is covered by the API regression; exercise its presentation too.
    await page.route(`${base}/tasks/${running.id}`, async route => { const response = await route.fetch(); await route.fulfill({ response, json: { ...(await response.json()), state: 'committing' } }); });
    await page.goto(`${base}/ui/tasks/${running.id}`);
    await expect(page.getByText('Committing · not cancellable', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel task…', exact: true })).toHaveCount(0);
    await page.unroute(`${base}/tasks/${running.id}`); await page.reload();
    await page.getByRole('button', { name: 'Cancel task…', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm cancellation' }).click();
    await expect(page.getByText('Cancelled by you', { exact: true }).first()).toBeVisible();
  } finally { await call(`/tasks/${running.id}/cancel`, 'POST', {}); }
});

test('an unresolved attempt survives an actual service restart with new sessions and the same database', async ({ page }) => {
  const data = await mkdtemp(join(tmpdir(), 'devagents-u3-restart-'));
  const db = join(data, 'test.db'); const status = await (await call('/status')).json();
  let store = new Store(db, []); let service = new TaskService(store, Config.parse({ schemaVersion: 1 }), data);
  await service.registerProject({ id: 'restart-project', path: root });
  let server = createApi(service, 'fixture-restart-token', { uiRoot: join(process.cwd(), 'dist/ui'), status: async () => status });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const restartPort = (server.address() as AddressInfo).port; const origin = `http://127.0.0.1:${restartPort}`;
  const login = async () => {
    const response = await fetch(`${origin}/ui/bootstrap`, { method: 'POST', headers: { authorization: 'Bearer fixture-restart-token', 'content-type': 'application/json' }, body: '{}' });
    await page.goto((await response.json()).url);
    await page.goto(`${origin}/ui/tasks/new`);
  };
  try {
    await login(); await page.getByLabel('Project', { exact: true }).selectOption('restart-project');
    await page.getByLabel('What should the team do?').fill('Survive actual restart');
    await page.route(`${origin}/tasks`, async route => { if (route.request().method() !== 'POST') return route.continue(); await route.fetch(); await route.abort(); });
    await page.getByRole('button', { name: 'Submit task', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Retry this attempt' })).toBeEnabled();
    const original = store.summaries({ limit: 20 }).tasks[0]!;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close();
    store = new Store(db, []); service = new TaskService(store, Config.parse({ schemaVersion: 1, defaultMode: 'autonomous' }), data);
    server = createApi(service, 'fixture-restart-token', { uiRoot: join(process.cwd(), 'dist/ui'), status: async () => status });
    await new Promise<void>(resolve => server.listen(restartPort, '127.0.0.1', resolve));
    await page.unroute(`${origin}/tasks`); await page.reload();
    await expect(page).toHaveURL(`${origin}/ui/signed-out`);
    await login();
    await expect(page.getByRole('button', { name: 'Retry this attempt' })).toBeEnabled();
    await page.getByRole('button', { name: 'Retry this attempt' }).click();
    await expect(page.getByText('Task accepted', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open task' })).toHaveAttribute('href', `/ui/tasks/${original.id}`);
    expect(store.summaries({ limit: 20 }).tasks).toHaveLength(1); expect(store.task(original.id).mode).toBeUndefined();
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); await rm(data, { recursive: true, force: true }); }
});

test('real HTTP diffs distinguish hostile truncated text, binary, empty and missing commits', async ({ page }) => {
  const f = await diffFixture();
  const status = await (await call('/status')).json();
  const server = createApi(f.service, 'synthetic-diff-token', { uiRoot: join(process.cwd(), 'dist/ui'), status: async () => status });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const complete = async (files: Record<string, string | Buffer>) => {
    const task = f.service.submit({ projectId: 'fixture', request: 'Browser diff fixture', mode: 'autonomous' }, crypto.randomUUID());
    const workspace = await new WorkspaceManager(f.dataDir).create(f.store.project('fixture'), task.id, task.request);
    for (const [name, contents] of Object.entries(files)) await writeFile(join(workspace.path, name), contents);
    await git(workspace.path, ['add', '.']);
    await git(workspace.path, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'Browser diff fixture']);
    const commit = await git(workspace.path, ['rev-parse', 'HEAD']);
    let t = f.store.checkpoint(task.id, f.store.task(task.id).version, { workspace }, 'fixture');
    for (const state of ['ready', 'running', 'validating', 'reviewing', 'committing'] as const) t = f.store.transition(task.id, t.version, state, 'fixture', 'fixture');
    return f.store.transition(task.id, t.version, 'completed', 'fixture', 'done', { outcome: { commit, repairCycles: 0 } });
  };
  try {
    const changed = await complete({ '<img src=x onerror=alert(1)>': 'fixture-secret-value\n' + '<script>alert(1)</script>\n'.repeat(5000), 'asset.bin': Buffer.from([0, 1, 2]), 'README.md': '# Updated fixture\n++header-like content\n' });
    const empty = await complete({});
    const response = await fetch(`${origin}/ui/bootstrap`, { method: 'POST', headers: { authorization: 'Bearer synthetic-diff-token', 'content-type': 'application/json' }, body: '{}' });
    await page.goto((await response.json()).url);
    const openResult = async (id: string) => { await page.goto(`${origin}/ui/tasks/${id}`); await page.getByRole('tab', { name: 'Result', exact: true }).click(); };
    await openResult(changed.id);
    const selected = page.getByRole('region', { name: 'Selected file diff' });
    await expect(selected).toContainText('<script>alert(1)</script>');
    await expect(selected).toContainText('[REDACTED]'); await expect(selected).not.toContainText('fixture-secret-value');
    await expect(selected).toContainText('Truncated by the display or read limit.');
    await expect(page.locator('#app script, #app img')).toHaveCount(0);
    await page.getByRole('button', { name: /README.md/ }).click();
    const patch = selected.getByLabel('File patch');
    await expect(patch.locator('.diff-removed')).toHaveText('-# Fixture\n');
    await expect(patch.locator('.diff-added')).toHaveText(['+# Updated fixture\n', '+++header-like content\n']);
    await expect(patch.locator('.diff-meta').filter({ hasText: /^\+\+\+ b\// })).toHaveCount(1);
    await expect(patch.locator('.diff-added').first()).toHaveCSS('background-color', 'rgb(218, 251, 225)');
    await expect(patch.locator('.diff-removed')).toHaveCSS('background-color', 'rgb(255, 235, 233)');
    await expect(patch.locator('.diff-hunk')).toHaveCSS('background-color', 'rgb(221, 244, 255)');
    const diffResponse = await fetch(`${origin}/tasks/${changed.id}/diff`, { headers: { authorization: 'Bearer synthetic-diff-token' } });
    const diff = await diffResponse.json();
    expect(await patch.textContent()).toBe(diff.files.find((file: { path: string }) => file.path === 'README.md').text);
    await patch.screenshot({ path: join(shots, 'colored-diff-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(patch).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await selected.screenshot({ path: join(shots, 'colored-diff-mobile.png') });
    await page.setViewportSize({ width: 1360, height: 900 });
    await page.getByRole('button', { name: /asset.bin/ }).click(); await expect(page.getByText('Binary content is not shown.', { exact: true })).toBeVisible();
    await openResult(empty.id); await expect(page.getByText('Both commits exist.', { exact: false })).toBeVisible();
    await git(f.project, ['update-ref', '-d', `refs/heads/${changed.workspace!.branch}`]);
    await openResult(changed.id);
    await expect(page.getByRole('alert')).toContainText('Recorded repository, commits or task branch are unavailable');
    await expect(page.getByText('Both commits exist.', { exact: false })).toHaveCount(0);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.cleanup(); }
});

test('overview setup hint follows availability and projects; fixture limits match the status contract', async ({ page }) => {
  const status = await (await call('/status')).json();
  expect(Object.keys(status.limits).sort()).toEqual(['concurrency', 'executionTimeoutMs', 'maxRepairCycles', 'validationTimeoutMs', 'workspaceScanLimit']);
  let locked = false;
  await page.route(`${base}/status`, route => route.fulfill({ json: { ...status, codex: { ...status.codex, installed: true, signedIn: true, vaultLocked: locked } } }));
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'Workspace', exact: true })).toBeVisible();
  await expect(page.getByText('✓ Sign-in saved', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Finish setup', exact: true })).toHaveCount(0);
  locked = true; await page.reload();
  await expect(page.getByRole('link', { name: 'Finish setup', exact: true })).toBeVisible();
  locked = false;
  await page.route(`${base}/projects`, route => route.fulfill({ json: [] })); await page.reload();
  await expect(page.getByRole('link', { name: 'Finish setup', exact: true })).toBeVisible();
});

test('settings and task details show the default-off policy and its frozen task value', async ({ page }) => {
  const status = await (await call('/status')).json(); expect(status.defaults.devagentsRules).toBe(false);
  await signIn(page); await page.goto(`${base}/ui/settings`);
  await expect(page.locator('dd').filter({ hasText: 'Off · engine sandbox' })).toBeVisible();
  await expect(page.getByText('Set DEVAGENTS_RULES=true in .env and restart to enable. Applies to new tasks.', { exact: true })).toBeVisible();
  await page.screenshot({ path: join(shots, 'execution-policy-settings.png'), fullPage: true });
  const response = await call('/tasks', 'POST', { projectId: 'fixture', request: 'Policy visibility fixture', mode: 'plan-approval' }, { 'idempotency-key': 'policy-visibility' });
  expect(response.ok).toBe(true); const task = await response.json(); expect(task.devagentsRules).toBe(false);
  await page.goto(`${base}/ui/tasks/${task.id}`);
  await expect(page.getByText('Extra DevAgents rules: off · engine sandbox · frozen at submission', { exact: true })).toBeVisible();
  await page.screenshot({ path: join(shots, 'execution-policy-task.png'), fullPage: true });
  await call(`/tasks/${task.id}/cancel`, 'POST', {});
});


test('older plans remain readable without a verification summary', async ({ page }) => {
  await signIn(page); await stopInitialHold(page);
  const submitted = await call('/tasks', 'POST', { projectId: 'fixture', request: 'Legacy plan compatibility fixture', mode: 'plan-approval' }, { 'idempotency-key': crypto.randomUUID() });
  expect(submitted.ok).toBe(true);
  const { id } = await submitted.json();
  await expect.poll(async () => (await (await call(`/tasks/${id}`)).json()).state).toBe('awaiting_plan_approval');
  expect((await call(`/tasks/${id}/cancel`, 'POST', {})).ok).toBe(true);
  const task = await (await call(`/tasks/${id}`)).json();
  const summary = task.plan.summary;
  await page.route(`${base}/tasks/${task.id}`, async route => {
    const response = await route.fetch(); const body = await response.json();
    delete body.plan.verification;
    await route.fulfill({ response, json: body });
  });
  await page.goto(`${base}/ui/tasks/${task.id}`);
  await page.getByRole('tab', { name: 'Plan', exact: true }).click();
  await expect(page.locator('.plan-lead')).toHaveText(summary);
  await expect(page.getByText(/This plan has no plain-language verification summary/)).toBeVisible();
  await page.locator('.plan-details > summary').click();
  await expect(page.locator('.plan-items')).toBeVisible();
});
