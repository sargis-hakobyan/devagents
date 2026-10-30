import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { fixture, validPlan } from '../helpers.js';
import { BrowserSessions } from '../../src/api/session.js';
import { createApi } from '../../src/api/server.js';

// Dedicated temporary data: boundary cases do not contaminate the existing visual fixtures.
let f: Awaited<ReturnType<typeof fixture>>;
let server: ReturnType<typeof createApi>;
let sessions: BrowserSessions;
let base: string; let rejectedId: string; let approvedId: string; let completedId: string; let runningId: string;
async function signIn(page: Page, path: string) {
  await page.goto(`${base}/ui/login?code=${sessions.mintCode()}`);
  await page.goto(base + path);
}
test.beforeAll(async () => {
  f = await fixture(); sessions = new BrowserSessions();
  const submit = (request: string, mode?: 'autonomous' | 'plan-approval') => f.service.submit({ projectId: 'fixture', request, ...(mode ? { mode } : {}) }, request);
  const rejected = submit('Rejected without approval', 'plan-approval'); rejectedId = rejected.id;
  await f.service.proposePlan(rejectedId, validPlan()); f.service.cancel(rejectedId);
  const approved = submit('Approved then cancelled', 'plan-approval'); approvedId = approved.id;
  const planned = await f.service.proposePlan(approvedId, validPlan()); f.service.approve(approvedId, planned.version); f.service.cancel(approvedId);
  const completed = submit('Completed with large evidence', 'autonomous'); completedId = completed.id;
  await f.service.proposePlan(completedId, validPlan());
  for (const state of ['running', 'validating', 'reviewing', 'completed'] as const) f.store.transition(completedId, f.store.task(completedId).version, state, 'fixture', 'fixture transition');
  for (const [exitCode, truncated] of [[1, false], [0, false], [0, true], [0, false]] as const) f.store.record(completedId, 'validation', { workItemId: 'greeting', executable: 'node', args: ['--test'], exitCode, truncated, output: 'output '.repeat(4000) });
  f.store.record(completedId, 'run-completed', { workItemId: 'greeting', phase: 'review', output: { approved: true, findings: [], summary: 'Successful independent review. '.repeat(1000) } });
  const running = submit('Old running task remains visible', 'autonomous'); runningId = running.id;
  const ready = await f.service.proposePlan(runningId, validPlan()); f.store.transition(runningId, ready.version, 'running', 'fixture', 'started');
  const waiting = submit('Old approval remains discoverable', 'plan-approval'); await f.service.proposePlan(waiting.id, validPlan());
  for (let i = 0; i < 51; i++) submit(`Mode choice ${i}`);
  for (let i = 0; i < 201; i++) f.service.cancel(submit(`New cancelled ${i}`).id);
  server = createApi(f.service, 'synthetic-ui-review-token', {
    sessions, uiRoot: resolve('dist/ui'), status: async () => ({
      service: { executionEnabled: false, startedAt: new Date().toISOString() },
      codex: { installed: false, signedIn: false, vaultLocked: false, modelAccessVerified: false },
      defaults: { providers: [] }, limits: { concurrency: 2 }, fixture: { label: 'Synthetic UI regression data; no models or credentials' },
    }),
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => {
  server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  await f?.cleanup();
});

test('overview keeps old running work visible and links to all attention tasks beyond the preview', async ({ page }) => {
  await signIn(page, '/ui/');
  await expect(page.getByText('Needs your attention · 52')).toBeVisible();
  await expect(page.getByText('Old running task remains visible')).toBeVisible();
  await expect(page.locator(`a[href="/ui/tasks/${runningId}"]`)).toBeVisible();
  await expect(page.getByText('Showing 50 of 52.')).toBeVisible();
  await page.getByRole('link', { name: 'View all tasks needing attention' }).click();
  await expect(page.getByRole('button', { name: 'Needs you · 52' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('tbody tr')).toHaveCount(50);
});
test('state filters query across pages and reset the cursor when switching groups', async ({ page }) => {
  await signIn(page, '/ui/tasks');
  await page.getByRole('button', { name: 'Needs you · 52' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(50);
  await page.getByRole('button', { name: 'Older →' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(2);
  await expect(page.getByText('Old approval remains discoverable', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Active · 1' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.getByText('Old running task remains visible', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '← Newer' })).toBeDisabled();
});
test('cancelled plans distinguish rejection from a recorded approval', async ({ page }) => {
  await signIn(page, `/ui/tasks/${rejectedId}`); await page.getByRole('tab', { name: 'Plan', exact: true }).click();
  await expect(page.getByText('Plan · not approved', { exact: true })).toBeVisible();
  await expect(page.getByText(/approved by you/)).toHaveCount(0);
  await page.goto(`${base}/ui/tasks/${approvedId}`); await page.getByRole('tab', { name: 'Plan', exact: true }).click();
  await expect(page.getByText(/Plan · approved by you/)).toBeVisible();
});
test('large evidence retains pass, failure, truncation and review outcomes in every task view', async ({ page }) => {
  await signIn(page, `/ui/tasks/${completedId}`);
  await expect(page.getByText('Review ✓', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: /Activity/ }).click();
  await expect(page.locator('summary', { hasText: 'validation passed' })).toHaveCount(2);
  await expect(page.locator('summary', { hasText: 'validation failed (exit 1)' })).toHaveCount(1);
  await expect(page.locator('summary', { hasText: 'validation failed (output truncated)' })).toHaveCount(1);
  await expect(page.getByText(/exit undefined/)).toHaveCount(0);
  await expect(page.locator('summary', { hasText: 'review run completed · item greeting · approved' })).toHaveCount(1);
  await page.getByRole('tab', { name: 'Result' }).click();
  await expect(page.locator('dl.kv')).toContainText('2 of 4 validation runs passed');
  await expect(page.locator('dl.kv')).toContainText('Approved · Successful independent review.');
});
