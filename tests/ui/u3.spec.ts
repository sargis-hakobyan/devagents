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

test('registration preserves input on backend refusal and registers an existing checkout', async ({ page }) => {
  await signIn(page); await page.goto(`${base}/ui/projects/new`);
  await page.getByLabel('Project ID', { exact: true }).fill('browser-project');
  await page.getByLabel('Absolute path as the service sees it').fill('/projects/not-mounted');
  await page.getByRole('button', { name: 'Register project', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('mount the checkout and register its container path');
  await expect(page.getByLabel('Project ID', { exact: true })).toHaveValue('browser-project');
  await expect(page.getByLabel('Absolute path as the service sees it')).toHaveValue('/projects/not-mounted');
  await page.screenshot({ path: join(shots, 'u3-register-error.png'), fullPage: true });
  await page.getByLabel('Absolute path as the service sees it').fill(root);
  await page.getByRole('button', { name: 'Register project', exact: true }).click();
  await expect(page.getByText('Repository registered', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Submit work' })).toHaveAttribute('href', '/ui/tasks/new?project=browser-project');
  expect((await (await call('/projects')).json()).find((p: { id: string }) => p.id === 'browser-project').path).toBe(await realpath(root));
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
  await page.getByRole('button', { name: 'Add criterion' }).click();
  await page.getByLabel('Criterion 1', { exact: true }).fill('Keep existing tests');
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
  expect(task.state).toBe('awaiting_mode'); expect(task.acceptanceCriteria).toEqual(['Keep existing tests']);
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
  await page.screenshot({ path: join(shots, 'u3-approval.png'), fullPage: true });
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
  await expect(page.getByLabel('Criterion 1', { exact: true })).toHaveValue('Keep history');
  await expect(page.getByLabel('Project', { exact: true })).toHaveValue('');
  expect(await page.evaluate(() => sessionStorage.getItem('devagents.submission.v1'))).toBeNull();
});

test('guided setup uses status and terminal commands without credential fields or automatic tests', async ({ page }) => {
  await signIn(page);
  const posts: string[] = []; page.on('request', r => { if (r.method() === 'POST') posts.push(r.url()); });
  await page.route(`${base}/status`, async route => {
    const response = await route.fetch(); const status = await response.json();
    await route.fulfill({ response, json: { ...status, codex: { ...status.codex, installed: false, signedIn: false, vaultLocked: true } } });
  });
  await page.goto(`${base}/ui/settings/setup`);
  await expect(page.getByRole('heading', { name: 'Get ready to run work' })).toBeVisible();
  await expect(page.getByText('Credentials locked', { exact: true })).toBeVisible();
  await expect(page.getByText('✕ Not installed', { exact: true })).toBeVisible();
  await expect(page.getByText('npm run cli -- auth setup', { exact: true })).toBeVisible();
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
    const workspace = await new WorkspaceManager(f.dataDir).create(f.store.project('fixture'), task.id);
    for (const [name, contents] of Object.entries(files)) await writeFile(join(workspace.path, name), contents);
    await git(workspace.path, ['add', '.']);
    await git(workspace.path, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'Browser diff fixture']);
    const commit = await git(workspace.path, ['rev-parse', 'HEAD']);
    let t = f.store.checkpoint(task.id, f.store.task(task.id).version, { workspace }, 'fixture');
    for (const state of ['ready', 'running', 'validating', 'reviewing', 'committing'] as const) t = f.store.transition(task.id, t.version, state, 'fixture', 'fixture');
    return f.store.transition(task.id, t.version, 'completed', 'fixture', 'done', { outcome: { commit, repairCycles: 0 } });
  };
  try {
    const changed = await complete({ '<img src=x onerror=alert(1)>': 'fixture-secret-value\n' + '<script>alert(1)</script>\n'.repeat(5000), 'asset.bin': Buffer.from([0, 1, 2]) });
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
