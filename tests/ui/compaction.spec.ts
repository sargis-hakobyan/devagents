import { test, expect } from '@playwright/test';
import { port } from './playwright.config.js';

// UI-only contract: synthetic responses exercise confirmation without touching worktrees.
test('compaction previews escaped paths and sends only the reviewed digest on explicit confirmation', async ({ page }) => {
  const id = '11111111-1111-4111-8111-111111111111';
  const digest = `${Date.now() + 600000}.${'a'.repeat(64)}`; let removals = 0;
  await page.route('**/status', route => route.fulfill({ json: { service: { host: '127.0.0.1', port, platform: 'fixture' }, codex: { installed: false, signedIn: false } } }));
  await page.route('**/overview', route => route.fulfill({ json: { counts: {}, attention: [], active: [], recent: [] } }));
  await page.route('**/ui/session', route => route.fulfill({ json: { authenticated: true, csrfToken: 'fixture-csrf', expiresAt: new Date(Date.now() + 600000).toISOString() } }));
  await page.route(url => url.pathname === `/tasks/${id}`, route => route.fulfill({ json: { id, projectId: 'fixture', request: 'Finished work', state: 'cancelled', version: 3, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), acceptanceCriteria: [] } }));
  for (const endpoint of ['items', 'events', 'evidence']) await page.route(`**/tasks/${id}/${endpoint}*`, route => route.fulfill({ json: [] }));
  await page.route(`**/tasks/${id}/compaction-preview`, route => route.fulfill({ json: { taskId: id, digest, computedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(), reclaimableBytes: 1024 ** 3, candidates: [{ worktree: '/data/worktrees/<script>hostile</script>', path: 'node_modules', bytes: 1024 ** 3, entries: 2 }], kept: ['Source edits and history are kept.'] } }));
  await page.route(`**/tasks/${id}/compact`, async route => {
    removals++; expect(route.request().postDataJSON()).toEqual({ digest });
    await route.fulfill({ json: { removed: ['fixture/node_modules'], estimatedReclaimedBytes: 1024 ** 3 } });
  });
  await page.goto(`http://127.0.0.1:${port}/ui/tasks/${id}`);
  await page.getByRole('button', { name: 'Preview task compaction' }).click();
  await expect(page.getByText('Remove regenerable resources · 1.00 GiB estimated')).toBeVisible();
  await expect(page.getByText('/data/worktrees/<script>hostile</script>/node_modules', { exact: true })).toBeVisible();
  expect(removals).toBe(0);
  await page.getByRole('button', { name: 'Confirm compaction' }).click();
  await expect(page.getByText(/Compacted 1 resource directory/)).toBeVisible();
  expect(removals).toBe(1);
});
