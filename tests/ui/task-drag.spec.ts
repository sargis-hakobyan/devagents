import { test, expect } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureDir, port } from './playwright.config.js';

test('drop Available into Planning starts the full ticket; invalid drops, failures and retries preserve work', async ({ page }) => {
  const base = `http://127.0.0.1:${port}`;
  const bearer = (await readFile(join(fixtureDir, 'api-token'), 'utf8')).trim();
  const headers = { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' };
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    expect(response.ok).toBeTruthy(); return response.json();
  };
  const added = await call('/trackers', 'POST', { name: 'Drag tickets', url: 'https://tracker.fixture.invalid/mcp', token: 'fixture-tracker-token-0001' });
  const tool = added.tracker.id as string;
  const started: string[] = [];
  try {
    await call(`/trackers/${tool}/mapping`, 'PUT', added.suggestion);
    await call(`/projects/website/integrations/trackers/${tool}`, 'PUT', {});
    await call(`/projects/website/integrations/trackers/${tool}/rule`, 'PUT', { labels: ['devagents'] });
    await page.setViewportSize({ width: 1640, height: 1000 });
    await page.goto((await call('/ui/bootstrap', 'POST', {})).url);
    await page.goto(`${base}/ui/tasks?view=board`);
    const available = page.getByRole('region', { name: /^Available, / });
    const ticket = available.locator('.kb-ticket').filter({ hasText: 'FX-1' });
    const planning = page.getByRole('region', { name: /^Planning, / });
    const done = page.getByRole('region', { name: /^Done, / });
    await expect(ticket).toHaveAttribute('draggable', 'true');
    const posts: { key: string; payload: any }[] = [];
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/tasks') posts.push({ key: request.headers()['idempotency-key']!, payload: request.postDataJSON() }); });
    await ticket.dragTo(done);
    await expect(ticket).toBeVisible(); expect(posts).toHaveLength(0);
    // An external link/text drop cannot start a ticket.
    const transfer = await page.evaluateHandle(() => { const d = new DataTransfer(); d.setData('text/plain', 'FX-1'); return d; });
    await planning.dispatchEvent('drop', { dataTransfer: transfer });
    expect(posts).toHaveLength(0);

    // Full content is required for a direct start. A read failure leaves the card available.
    await page.route('**/tickets/content?**', route => route.fulfill({ status: 502, json: { error: 'unavailable', message: 'Ticket tool unavailable' } }));
    await ticket.dragTo(planning);
    await expect(page.getByRole('alert')).toContainText('Ticket tool unavailable');
    await expect(ticket).toHaveAttribute('draggable', 'true'); expect(posts).toHaveLength(0);
    await page.unroute('**/tickets/content?**');

    // Pause the submission response to check the real pending state and prevent a double start.
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/tasks', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      await gate;
      const response = await route.fetch(); const task = await response.json(); started.push(task.id);
      await route.fulfill({ response });
    });
    await ticket.dragTo(planning);
    await expect(planning.getByRole('status')).toContainText('FX-1: Add a contact form');
    await expect(planning.getByRole('status')).toContainText('Starting…');
    await expect(ticket).toHaveCount(0);
    await expect(available.getByRole('button', { name: 'Start task' }).first()).toBeDisabled();
    await expect.poll(() => posts.length).toBe(1);
    const shots = join(process.cwd(), 'test-results', 'ui-screenshots'); await mkdir(shots, { recursive: true });
    await page.screenshot({ path: join(shots, 'tasks-drag-starting.png'), fullPage: true });
    release();
    await expect(page.getByRole('status').filter({ hasText: 'Started FX-1.' })).toBeVisible();
    await expect(page).toHaveURL(/\/ui\/tasks\?view=board$/);
    const task = await call(`/tasks/${started[0]}`);
    expect(task.request).toContain('Visitors cannot reach us from the site.');
    expect(task.request).toContain('Please keep it to three fields.');
    expect(task.ticket).toMatchObject({ source: tool, key: 'FX-1' });
    expect(task.ticket.readAt).toBeTruthy(); expect(task.mode).toBe('plan-approval');
    const project = (await call('/projects')).find((p: any) => p.id === 'website');
    expect(task.team.id).toBe(project.defaultTeamId);
    await expect(page.locator(`a.kb-card[href="/ui/tasks/${task.id}"]`)).toBeVisible();
    await page.reload(); await expect(ticket).toHaveCount(0);
    await page.unroute('**/tasks');

    // Lose a successful response: the durable retry must recover exactly the same task after reload.
    await page.route('**/submission-options', async route => {
      const response = await route.fetch(); const options = await response.json();
      options.projects.find((p: any) => p.projectId === 'website').mode = null;
      await route.fulfill({ json: options });
    });
    await page.route('**/tasks', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch(); started.push((await response.json()).id);
      await route.abort('failed');
    });
    const second = available.locator('.kb-ticket').filter({ hasText: 'FX-2' });
    await second.getByRole('button', { name: 'Start task' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Retry start' })).toBeVisible();
    expect(posts).toHaveLength(2); expect(posts[1]!.payload.mode).toBe('plan-approval');
    await page.reload();
    await expect(page.getByRole('button', { name: 'Retry start' })).toBeVisible();
    await page.unroute('**/tasks');
    await page.getByRole('button', { name: 'Retry start' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Started FX-2.' })).toBeVisible();
    expect(posts).toHaveLength(3); expect(posts[2]).toEqual(posts[1]);
    expect((await call('/tasks?limit=200')).tasks.filter((t: any) => t.ticket?.source === tool && t.ticket?.key === 'FX-2')).toHaveLength(1);
    await expect(available.locator('.kb-ticket').filter({ hasText: 'FX-2' })).toHaveCount(0);

    // The hover-open Available column survives dragging out of its bounds.
    await available.getByRole('button', { name: /Available stays open/ }).click();
    await page.getByRole('button', { name: /^Available, .*Open$/ }).hover({ force: true });
    const third = available.locator('.kb-ticket').first();
    await expect(third).toBeVisible();
    // Start the pointer motion before locating the target: the overlay makes room for it during a drag.
    const source = (await third.locator('.kb-title').boundingBox())!;
    await page.mouse.move(source.x + 10, source.y + 10); await page.mouse.down();
    await page.mouse.move(source.x + 30, source.y + 10, { steps: 5 });
    await expect(planning).toContainText('Drop to start planning');
    await page.screenshot({ path: join(shots, 'tasks-drag-target.png'), fullPage: true });
    const target = (await planning.boundingBox())!;
    await page.mouse.move(target.x + target.width / 2, target.y + 30, { steps: 8 });
    await page.mouse.up();
    await expect(page.getByRole('status').filter({ hasText: 'Started FX-3.' })).toBeVisible();
    const all = await call('/tasks?limit=200');
    for (const t of all.tasks.filter((t: any) => t.ticket?.source === tool)) if (!started.includes(t.id)) started.push(t.id);
    expect(started).toHaveLength(3);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(shots, 'tasks-drag-mobile.png'), fullPage: true });
  } finally {
    for (const id of started) await fetch(`${base}/tasks/${id}/cancel`, { method: 'POST', headers, body: '{}' });
    await call(`/projects/website/integrations/trackers/${tool}`, 'DELETE');
    await call(`/trackers/${tool}`, 'DELETE');
  }
});
