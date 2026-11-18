import { test, expect } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureDir, port } from './playwright.config.js';

// The fixture answers for a made-up ticket tool itself (scripts/fake-tracker.mjs); nothing reaches a network.
test('tasks are a board by stage, with what needs you above it and available tickets that can be pinned or collapsed', async ({ page }) => {
  const base = `http://127.0.0.1:${port}`;
  const bearer = (await readFile(join(fixtureDir, 'api-token'), 'utf8')).trim();
  const headers = { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' };
  const call = async (path: string, method = 'GET', body?: unknown) => (await fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).json() as Promise<any>;
  // A ticket tool with a rule for the website project, so Available has tickets.
  const added = await call('/trackers', 'POST', { name: 'Team board', url: 'https://tracker.fixture.invalid/mcp', token: 'fixture-tracker-token-0001' });
  const tool = added.tracker.id as string;
  await call(`/trackers/${tool}/mapping`, 'PUT', added.suggestion);
  await call(`/projects/website/integrations/trackers/${tool}`, 'PUT', {});
  await call(`/projects/website/integrations/trackers/${tool}/rule`, 'PUT', { labels: ['devagents'] });
  const link = await call('/ui/bootstrap', 'POST', {}) as { url: string };
  const shots = join(process.cwd(), 'test-results', 'ui-screenshots'); await mkdir(shots, { recursive: true });
  await page.setViewportSize({ width: 1640, height: 1000 });
  await page.goto(link.url);
  let started: string | undefined;
  try {
    await page.goto(`${base}/ui/tasks`);
    await expect(page.getByRole('heading', { level: 1, name: 'All tasks' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Board' })).toHaveAttribute('aria-pressed', 'true');

    // What waits for a decision is a band above the board, each with its one action, and is in no column.
    const you = page.getByRole('region', { name: /^Needs you, \d+ tasks?$/ });
    await expect(you.getByRole('link', { name: 'Review the plan' }).first()).toBeVisible();
    const waiting = (await you.locator('.kb-ytitle').first().textContent())!;
    const board = page.getByLabel('Tickets and tasks by stage');
    await expect(board.getByText(waiting, { exact: true })).toHaveCount(0);

    // One column per stage, each with its count, and a card per task that opens the task.
    for (const stage of ['Planning', 'Queued', 'Working', 'Done', 'Stopped']) await expect(board.getByRole('region', { name: new RegExp(`^${stage}, \\d+ tasks?$`) })).toBeVisible();
    const done = board.getByRole('region', { name: /^Done, / });
    await expect(done.locator('a.kb-card').first()).toContainText('Completed');
    await expect(board.getByRole('region', { name: /^Stopped, / })).toContainText('Failed');

    // Available: tickets of the connected tool that match the rule and have no task, with their source and number.
    const available = board.getByRole('region', { name: 'Available, 3 tickets' });
    await expect(available).toContainText('Team board'); await expect(available).toContainText('label devagents'); await expect(available).toContainText('for website');
    await expect(available.getByRole('link', { name: 'FX-1' })).toHaveAttribute('href', 'https://tracker.fixture.invalid/board?task=FX-1');
    await page.screenshot({ path: join(shots, 'u11-tasks-board.png'), fullPage: true });

    // The pin: pressed, the column stays; released, it folds to a strip that opens over the board on hover.
    const pin = available.getByRole('button', { name: /Available stays open/ });
    await expect(pin).toHaveAttribute('aria-pressed', 'true');
    await pin.click();
    const strip = board.getByRole('button', { name: 'Available, 3 tickets. Open' });
    await expect(strip).toBeVisible(); await expect(board.getByRole('region', { name: 'Available, 3 tickets' })).toHaveCount(0);
    // The opened column lies over the strip, so the pointer is moved there without waiting for the strip to stay on top.
    await strip.hover({ force: true });
    await expect(board.getByRole('region', { name: 'Available, 3 tickets' })).toBeVisible();
    await page.screenshot({ path: join(shots, 'u11-tasks-board-available-hover.png'), fullPage: true });
    await page.getByRole('heading', { level: 1, name: 'All tasks' }).hover();
    await expect(board.getByRole('region', { name: 'Available, 3 tickets' })).toHaveCount(0);
    // It also opens from the keyboard, and the choice survives a reload.
    await strip.focus(); await expect(board.getByRole('region', { name: 'Available, 3 tickets' })).toBeVisible();
    await page.keyboard.press('Escape'); await expect(board.getByRole('region', { name: 'Available, 3 tickets' })).toHaveCount(0);
    await page.reload();
    await expect(board.getByRole('button', { name: 'Available, 3 tickets. Open' })).toBeVisible();
    await board.getByRole('button', { name: 'Available, 3 tickets. Open' }).hover({ force: true });
    await board.getByRole('button', { name: /Available collapses/ }).click();
    await expect(board.getByRole('region', { name: 'Available, 3 tickets' }).getByRole('button', { name: /Available stays open/ })).toBeVisible();

    // The project filter and the search apply to tickets and tasks alike.
    await page.getByLabel('Search request text on this page').fill('footer');
    await expect(board.getByRole('region', { name: 'Available, 1 ticket' })).toContainText('Fix the footer links');
    await page.getByLabel('Search request text on this page').fill('');

    // Clicking a ticket opens the submit form with everything preselected; nothing is started until it is submitted.
    const website = (await call('/projects') as { id: string; defaultTeamId?: string }[]).find(p => p.id === 'website')!;
    const usual = (await call('/submission-options') as { projects: { projectId: string; mode: string | null }[] }).projects.find(p => p.projectId === 'website')!;
    await board.getByRole('region', { name: 'Available, 3 tickets' }).getByText('Add a contact form').click();
    await expect(page).toHaveURL(/\/ui\/tasks\/new\?project=website$/);
    const form = page.locator('form');
    await expect(form).toContainText('From Team board ticket FX-1.');
    await expect(form.getByRole('link', { name: 'FX-1' })).toHaveAttribute('href', 'https://tracker.fixture.invalid/board?task=FX-1');
    // The project comes from the ticket's rule, so it is shown and not offered as a choice.
    await expect(form).toContainText("set by the ticket's rule"); await expect(form.getByRole('combobox', { name: 'Project', exact: true })).toHaveCount(0);
    // The ticket itself is read from the tool: its description and comments are the request, and its files are named.
    await expect(form).toContainText('Its description and 2 comments are in the request below. Pictures and short text files among its 3 files go to the team when the task starts.');
    await expect(form.locator('textarea')).toHaveValue([
      'FX-1: Add a contact form', 'Visitors cannot reach us from the site.', 'Add a contact form to the footer with name, email and message.',
      'Comments on the ticket:', 'sam@example.com, 2026-11-02:\nThe form should send to the support inbox.', 'agents@example.com, 2026-11-03:\nPlease keep it to three fields.\nSee the screenshot.',
      'Files on the ticket: footer.png, notes.txt, elsewhere.png', 'Ticket: https://tracker.fixture.invalid/board?task=FX-1',
    ].join('\n\n'));
    // Its files are shown: a picture as a thumbnail that opens full size, a text file as an icon, and a picture that cannot be fetched falls back to its icon.
    const files = form.getByRole('list', { name: 'Files on the ticket' });
    const thumb = files.getByRole('img', { name: 'footer.png, picture from the ticket' });
    await expect(thumb).toBeVisible(); await expect.poll(() => thumb.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    await expect(files.getByRole('link', { name: 'Open footer.png full size' })).toHaveAttribute('href', /^\/tickets\/picture\?projectId=website&source=[0-9a-f-]{36}&key=FX-1&index=0$/);
    await expect(files.getByRole('listitem').filter({ hasText: 'notes.txt' }).getByRole('img', { name: 'Text file' })).toBeVisible();
    await expect(files.getByRole('listitem').filter({ hasText: 'elsewhere.png' }).getByRole('img', { name: 'Picture', exact: true })).toBeVisible();
    // Team and autonomy mode start on what the project would use, as explicit choices that can be changed.
    await expect(form.getByRole('combobox', { name: 'Team', exact: true })).toHaveValue(website.defaultTeamId ?? '');
    await expect(form.locator(`input[name="mode"][value="${usual.mode ?? ''}"]`)).toBeChecked();
    await form.locator('textarea').fill('FX-1: Add a contact form, with a spam check');
    await form.locator('input[name="mode"][value="plan-approval"]').check();
    await expect(form.locator('input[name="mode"][value="plan-approval"]')).toBeChecked();
    await expect(form.getByRole('button', { name: 'Submit task' })).toBeEnabled();
    await page.screenshot({ path: join(shots, 'u11-submit-from-ticket.png'), fullPage: true });
    // The button on the card does the same, for the keyboard.
    await page.goto(`${base}/ui/tasks`);
    await board.getByRole('region', { name: 'Available, 3 tickets' }).getByRole('button', { name: 'Start task' }).first().click();
    await expect(page.locator('form')).toContainText('From Team board ticket FX-1.');
    // Submitted, the task records its ticket and what it was given from it, and the ticket leaves Available.
    await expect(page.locator('form')).toContainText('Its description and 2 comments');
    await page.locator('form input[name="mode"][value="plan-approval"]').check();
    await page.getByRole('button', { name: 'Submit task' }).click();
    await page.getByRole('link', { name: 'Open task' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'FX-1: Add a contact form' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'FX-1', exact: true })).toHaveAttribute('href', 'https://tracker.fixture.invalid/board?task=FX-1');
    await expect(page.locator('body')).toContainText('From Team board ticket FX-1');
    // The files are fetched when the task's turn comes; that is covered by tests/integration/ticket-files.test.ts.
    started = /\/ui\/tasks\/([a-f0-9-]{36})/.exec(page.url())?.[1];
    await page.getByText('Full request').click();
    await expect(page.locator('.request-full pre')).toContainText('Please keep it to three fields.');
    await page.screenshot({ path: join(shots, 'u11-task-from-ticket.png'), fullPage: true });
    await page.goto(`${base}/ui/tasks`);
    await expect(board.getByRole('region', { name: 'Available, 2 tickets' })).toBeVisible();

    // The list is one switch away and is remembered; a link to a state group opens the list.
    await page.goto(`${base}/ui/tasks`);
    await page.getByRole('button', { name: 'List' }).click();
    await expect(page.getByRole('columnheader', { name: 'Request' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('columnheader', { name: 'Request' })).toBeVisible();
    await page.getByRole('button', { name: 'Board' }).click();
    await expect(board).toBeVisible();
    await page.goto(`${base}/ui/tasks?group=finished`);
    await expect(page.getByRole('button', { name: /^Finished/ })).toHaveAttribute('aria-pressed', 'true');
  } finally {
    // Leave the shared fixture without a waiting task of this workflow.
    if (started) await fetch(`${base}/tasks/${started}/cancel`, { method: 'POST', headers, body: '{}' }).catch(() => undefined);
    await call(`/projects/website/integrations/trackers/${tool}`, 'DELETE');
    await call(`/trackers/${tool}`, 'DELETE');
  }
});
