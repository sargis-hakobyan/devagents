import { test, expect } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureDir, port } from './playwright.config.js';

// The fixture answers for a made-up ticket tool itself (scripts/fake-tracker.mjs); nothing reaches a network.
const ADDRESS = 'https://tracker.fixture.invalid/mcp';
const TOKEN = 'fixture-tracker-token-0001';

test('a ticket tool is added by its MCP address, mapped, and used by a project with a ticket rule', async ({ page }) => {
  const base = `http://127.0.0.1:${port}`;
  const bearer = (await readFile(join(fixtureDir, 'api-token'), 'utf8')).trim();
  const headers = { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' };
  const link = await (await fetch(`${base}/ui/bootstrap`, { method: 'POST', headers, body: '{}' })).json() as { url: string };
  const shots = join(process.cwd(), 'test-results', 'ui-screenshots'); await mkdir(shots, { recursive: true });
  await page.goto(link.url);
  try {
    await page.getByRole('link', { name: 'Tools' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Ticket tools' })).toBeVisible();
    await expect(page.getByText('No tool is added yet')).toBeVisible();
    await expect(page.getByText('does not start tasks from tickets or write to the tool yet')).toBeVisible();

    // A refused token is reported next to the form and nothing is added.
    await page.getByRole('button', { name: 'Add a tool' }).click();
    const add = page.getByRole('region', { name: 'Add a tool' });
    await add.getByLabel('Name').fill('Team board'); await add.getByLabel('MCP server address').fill(ADDRESS);
    await add.getByLabel('Token').fill('a-rejected-token-0001');
    await add.getByRole('button', { name: 'Add tool' }).click();
    await expect(add.getByRole('alert')).toContainText('Team board did not accept this token');
    await add.getByLabel('Token').fill(TOKEN);
    await add.getByRole('button', { name: 'Add tool' }).click();

    // The tool is saved. Its setup is seven fields, found by DevAgents and shown with the values of one real ticket.
    const tool = page.getByRole('article', { name: /^Team board/ });
    await expect(tool).toContainText('Needs mapping'); await expect(tool).toContainText(ADDRESS);
    const mapping = page.getByRole('form', { name: 'Mapping for Team board' });
    await expect(mapping).toContainText('DevAgents found all seven by itself.'); await expect(mapping).toContainText('Read from ticket FX-1 just now');
    const fields = mapping.getByRole('group', { name: 'Fields read from a ticket' });
    for (const [word, field] of [['Ticket number', 'key'], ['Title', 'title'], ['Link', 'url'], ['Project', 'projectId'], ['Status', 'status'], ['Assignee', 'assignee'], ['Label', 'labels']]) await expect(fields.getByLabel(`Field for ${word}`, { exact: true })).toHaveValue(field!);
    for (const value of ['FX-1', 'Add a contact form', 'tracker.fixture.invalid/board?task=FX-1', 'Website', 'ready-for-development', 'agents@example.com', 'devagents']) await expect(fields).toContainText(value);
    await expect(fields.getByText('✓ Found')).toHaveCount(7);
    await page.screenshot({ path: join(shots, 'u10-tools-mapping.png'), fullPage: true });

    // A field that is not chosen says what stops working; the rest stays as it is.
    await fields.getByLabel('Field for Label', { exact: true }).selectOption('');
    await expect(mapping).toContainText('6 of 7 fields are set.'); await expect(fields).toContainText('Tickets cannot be picked by label');
    await expect(fields.getByText('⚠ Missing')).toHaveCount(1);
    await fields.getByLabel('Field for Label', { exact: true }).selectOption('labels');

    // How the tool is called is filled in automatically and folded away. A wrong value there is refused by the tool's own answer.
    const how = mapping.locator('details');
    await expect(how.getByLabel('List tickets with')).toBeHidden();
    await how.locator('summary').click();
    await expect(how.getByLabel('List tickets with')).toHaveValue('tracker_list_work');
    await expect(how.getByLabel('Always send assignment')).toHaveValue('all');
    await expect(how.getByLabel('Filter by column with')).toHaveValue('statuses');
    await expect(how.getByLabel('Filter by assignee with')).toHaveValue('');
    await expect(how.getByLabel('Statuses a rule can name, in board order')).toHaveValue('backlog, todo, ready-for-development, in-progress, done');
    await how.getByLabel('Tickets are in').fill('issues');
    await mapping.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(mapping.getByRole('alert')).toContainText('has no list at "issues"');
    await how.getByLabel('Tickets are in').fill('tasks');
    await mapping.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(mapping).toContainText('Saved. 5 tickets read from Team board.');
    await expect(tool).toContainText('Connected'); await expect(tool).toContainText('acts as agents@example.com');
    await expect(page.locator('body')).not.toContainText(TOKEN);

    // A project connects the tool and chooses its tickets.
    await page.goto(`${base}/ui/projects/website`);
    // The added tool is chosen from a list: its address and token are not entered again.
    const tile = page.getByRole('article', { name: /^Ticket tool/ });
    await expect(tile).toContainText('Not connected'); await expect(tile).toContainText('1 added tool to choose from');
    await tile.getByRole('button', { name: 'Connect' }).click();
    const choose = page.getByRole('region', { name: 'Ticket tool connection' });
    await expect(choose.getByLabel('Ticket tool').locator('option')).toHaveText(['Team board']);
    await expect(choose.locator('input[type="password"]')).toHaveCount(0);
    await choose.getByRole('button', { name: 'Connect' }).click();
    const panel = page.getByRole('region', { name: 'Team board connection' });
    await expect(panel).toContainText('Acts as agents@example.com');
    // A project can use more tools; this one is taken, so the next tile says there is none left to choose.
    await expect(page.getByRole('article', { name: /^Another ticket tool/ })).toContainText('Every added tool is in use here');
    const rule = panel.getByRole('form', { name: 'Which tickets' });
    await expect(rule).toContainText('A rule never means every ticket');
    await expect(rule.getByRole('button', { name: 'Save rule' })).toBeDisabled();
    await rule.getByLabel('from project').fill('web');
    await rule.locator('.ac-list [role="option"]', { hasText: 'Website' }).click();
    await rule.getByLabel('in column').selectOption('ready-for-development');
    await expect(rule).toContainText('Matches 2 tickets now: FX-1, FX-2');
    await rule.getByLabel('with label').fill('bug');
    await rule.locator('.ac-list [role="option"]', { hasText: 'bug' }).click();
    await expect(rule).toContainText('Matches 1 ticket now: FX-2');
    await page.screenshot({ path: join(shots, 'u10-tools-project-rule.png'), fullPage: true });
    await rule.getByRole('button', { name: 'Save rule' }).click();
    await expect(rule).toContainText('Rule saved.');
    const connected = page.getByRole('article', { name: /^Team board/ });
    await expect(connected).toContainText('project Website'); await expect(connected).toContainText('column ready-for-development');

    // The tool cannot be removed while the project uses it.
    await page.goto(`${base}/ui/tools`);
    await expect(tool).toContainText('Used by website');
    await tool.getByRole('button', { name: 'Manage' }).click();
    // The connection stays editable: name, address and token. A wrong address is refused and nothing changes.
    await tool.getByRole('button', { name: 'Edit connection' }).click();
    const edit = tool.getByRole('form', { name: 'Edit Team board' });
    await expect(edit.getByLabel('MCP server address')).toHaveValue(ADDRESS);
    await expect(edit.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    await edit.getByLabel('MCP server address').fill('http://tracker.fixture.invalid/mcp');
    await edit.getByRole('button', { name: 'Save changes' }).click();
    await expect(tool.getByRole('alert').last()).toContainText('must use https');
    await edit.getByLabel('MCP server address').fill(ADDRESS);
    await edit.getByLabel('Name').fill('Product board');
    await edit.getByRole('button', { name: 'Save changes' }).click();
    const renamed = page.getByRole('article', { name: /^Product board/ });
    await expect(renamed).toContainText('Used by website');
    await renamed.getByRole('button', { name: 'Edit connection' }).click();
    await renamed.getByRole('form', { name: 'Edit Product board' }).getByLabel('Name').fill('Team board');
    await renamed.getByRole('button', { name: 'Save changes' }).click();
    await expect(tool.getByRole('button', { name: 'Edit connection' })).toBeVisible();
    await tool.getByRole('button', { name: 'Remove tool' }).click();
    await tool.getByRole('button', { name: 'Yes, remove Team board' }).click();
    await expect(tool.getByRole('alert').last()).toContainText('is used by website');
  } finally {
    // Leave the shared fixture as it was for the other workflows.
    const { trackers } = await (await fetch(`${base}/trackers`, { headers })).json() as { trackers: { id: string }[] };
    for (const tracker of trackers) {
      await fetch(`${base}/projects/website/integrations/trackers/${tracker.id}`, { method: 'DELETE', headers });
      await fetch(`${base}/trackers/${tracker.id}`, { method: 'DELETE', headers });
    }
  }
});
