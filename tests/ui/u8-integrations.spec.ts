import { test, expect } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureDir, port } from './playwright.config.js';

// The fixture answers for GitHub and Jira itself; these tokens are made up and reach no network.
const GITHUB = `github_pat_${'fixture0'.repeat(4)}`;
const JIRA = `ATATT3xFfGF0${'fixture0'.repeat(4)}`;

test('a project connects GitHub and Jira with tokens, saves a ticket rule and disconnects again', async ({ page }) => {
  const base = `http://127.0.0.1:${port}`;
  const bearer = (await readFile(join(fixtureDir, 'api-token'), 'utf8')).trim();
  const headers = { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' };
  const integrations = `${base}/projects/website/integrations`;
  const link = await (await fetch(`${base}/ui/bootstrap`, { method: 'POST', headers, body: '{}' })).json() as { url: string };
  await page.goto(link.url); await page.goto(`${base}/ui/projects`);
  try {
    await page.locator('a[href="/ui/projects/website"]').click();
    await expect(page.getByRole('heading', { level: 1, name: 'website' })).toBeVisible();
    const github = page.getByRole('article', { name: /^GitHub/ }); const jira = page.getByRole('article', { name: /^Jira/ });
    await expect(github).toContainText('Not connected'); await expect(jira).toContainText('Not connected');
    await expect(page.getByText('does not open pull requests or start tasks from tickets yet')).toBeVisible();

    // GitHub: a refused token is reported next to the field and nothing is saved.
    await github.getByRole('button', { name: 'Connect' }).click();
    const githubPanel = page.getByRole('region', { name: 'GitHub connection' });
    await expect(githubPanel.getByText('example-org/website')).toBeVisible();
    await expect(githubPanel).toContainText('already cloned');
    const shots = join(process.cwd(), 'test-results', 'ui-screenshots'); await mkdir(shots, { recursive: true });
    await page.screenshot({ path: join(shots, 'u8-integrations-github-connect.png'), fullPage: true });
    await githubPanel.getByLabel('GitHub token').fill(`ghp_${'rejected'.repeat(4)}`);
    await githubPanel.getByRole('button', { name: 'Connect' }).click();
    await expect(githubPanel.getByRole('alert')).toContainText('GitHub did not accept this token');
    await expect(github).toContainText('Not connected');
    await githubPanel.getByLabel('GitHub token').fill(GITHUB);
    await githubPanel.getByRole('button', { name: 'Connect' }).click();
    await expect(githubPanel).toContainText('Signed in as @fixture-user');
    await expect(githubPanel).toContainText('Can push branches');
    await expect(github).toContainText('Connected'); await expect(github).toContainText('example-org/website');
    await expect(github.getByRole('button', { name: 'Manage' })).toBeVisible();
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    const stored = await (await fetch(integrations, { headers })).text();
    expect(stored).toContain('"repository":"example-org/website"'); expect(stored).not.toContain(GITHUB);

    // Jira: site, email and API token, then the rule with its live match line.
    await jira.getByRole('button', { name: 'Connect' }).click();
    const jiraPanel = page.getByRole('region', { name: 'Jira connection' });
    await expect(githubPanel).toHaveCount(0);
    await expect(jiraPanel.getByText('Where do I get the token?')).toBeVisible();
    await jiraPanel.getByText('Self-hosted').click();
    await expect(jiraPanel.getByLabel('Email of the Atlassian account')).toHaveCount(0);
    await expect(jiraPanel.getByLabel('Personal access token')).toBeVisible();
    await jiraPanel.getByText('Jira Cloud').click();
    await jiraPanel.getByLabel('Jira site').fill('example.atlassian.net');
    await jiraPanel.getByLabel('Email of the Atlassian account').fill('devagents@example.com');
    await jiraPanel.getByLabel('API token').fill(JIRA);
    await jiraPanel.getByLabel('Token end date (optional)').fill('2099-06-30');
    await page.screenshot({ path: join(shots, 'u8-integrations-jira-connect.png'), fullPage: true });
    await jiraPanel.getByRole('button', { name: 'Connect' }).click();
    await expect(jiraPanel).toContainText('Acts as DevAgents Bot');
    const rule = jiraPanel.getByRole('form', { name: 'Which tickets' });
    // The project is found by typing; nothing is preselected and the filters wait for it.
    const suggestions = rule.locator('.ac-list [role="option"]');
    const project = rule.getByLabel('Pick up tickets from project');
    await expect(project).toHaveValue(''); await expect(rule.getByLabel('in column')).toHaveCount(0);
    await project.fill('zzz'); await expect(rule.getByRole('listbox')).toContainText('No match.');
    await project.fill('web');
    await expect(suggestions).toHaveCount(1);
    await suggestions.filter({ hasText: 'WEB · Website' }).click();
    await expect(project).toHaveValue('WEB · Website');
    await expect(rule.getByRole('status').first()).toContainText('Choose a column, an assignee or a label');
    await expect(rule.getByRole('button', { name: 'Save rule' })).toBeDisabled();
    await rule.getByLabel('in column').selectOption('Ready for agents');
    await expect(rule.getByRole('status').first()).toContainText('Matches 3 tickets now: WEB-12, WEB-15, WEB-21');
    // Labels: typing narrows the list; the keyboard chooses.
    const label = rule.getByLabel('with label');
    await label.fill('bu'); await expect(suggestions).toHaveText(['bug']);
    await label.press('Enter'); await expect(label).toHaveValue('bug');
    await expect(rule.getByRole('status').first()).toContainText('No tickets match right now');
    await rule.getByRole('button', { name: 'Clear label' }).click();
    await expect(label).toHaveValue(''); await expect(rule.getByRole('status').first()).toContainText('Matches 3 tickets now');
    // People: found by part of the name, chosen with the mouse, cleared by emptying the field.
    const assignee = rule.getByLabel('assigned to');
    await assignee.fill('exam'); await expect(suggestions).toHaveText(['Sam Example', 'Anna Example']);
    await assignee.press('ArrowDown'); await assignee.press('Enter'); await expect(assignee).toHaveValue('Anna Example');
    await page.screenshot({ path: join(shots, 'u8-integrations-autocomplete.png'), fullPage: true });
    await assignee.fill('sam'); await assignee.press('Escape'); await expect(assignee).toHaveValue('Anna Example');
    await assignee.fill(''); await assignee.press('Tab'); await expect(assignee).toHaveValue('');
    await rule.getByText('Start on its own').click();
    await rule.getByRole('button', { name: 'Save rule' }).click();
    await expect(rule).toContainText('Rule saved.');
    await expect(jira).toContainText('project WEB, column Ready for agents');
    const saved = await (await fetch(integrations, { headers })).json() as { jira: { rule: { start: string; jql: string }; expiresOn: string } };
    expect(saved.jira.rule.start).toBe('auto'); expect(saved.jira.rule.jql).toBe('project = "WEB" AND status in (10001) ORDER BY created ASC'); expect(saved.jira.expiresOn).toBe('2099-06-30');
    expect(JSON.stringify(saved)).not.toContain(JIRA);

    // A second project reuses both saved tokens without pasting anything.
    await page.goto(`${base}/ui/projects/fixture`);
    await page.getByRole('article', { name: /^GitHub/ }).getByRole('button', { name: 'Connect' }).click();
    const reuse = page.getByRole('region', { name: 'GitHub connection' });
    await expect(reuse.getByRole('radio', { name: /Use the token saved for @fixture-user · used by project website/ })).toBeChecked();
    await expect(reuse.locator('input[type="password"]')).toHaveCount(0);
    await page.screenshot({ path: join(shots, 'u8-integrations-saved-token.png'), fullPage: true });
    await reuse.getByLabel('Repository').fill('example-org/website');
    await reuse.getByRole('button', { name: 'Connect' }).click();
    await expect(reuse).toContainText('Signed in as @fixture-user');
    await expect(reuse).toContainText('One token, also used by project website.');
    await page.getByRole('article', { name: /^Jira/ }).getByRole('button', { name: 'Connect' }).click();
    const reuseJira = page.getByRole('region', { name: 'Jira connection' });
    await expect(reuseJira.getByRole('radio', { name: /Use the token saved for DevAgents Bot · example\.atlassian\.net/ })).toBeChecked();
    await expect(reuseJira.getByLabel('Jira site')).toHaveCount(0);
    await reuseJira.getByRole('button', { name: 'Connect' }).click();
    await expect(reuseJira).toContainText('Acts as DevAgents Bot');
    await expect(reuseJira.getByRole('form', { name: 'Which tickets' }).getByLabel('Pick up tickets from project')).toHaveValue('');
    const both = await (await fetch(integrations, { headers })).json() as { savedTokens: { github: { usedBy: { id: string }[] }[]; jira: { usedBy: { id: string }[] }[] } };
    expect(both.savedTokens.github).toHaveLength(1); expect(both.savedTokens.github[0]!.usedBy.map(p => p.id)).toEqual(['fixture', 'website']);
    expect(both.savedTokens.jira[0]!.usedBy.map(p => p.id)).toEqual(['fixture', 'website']);

    // The saved state survives a reload, on desktop and at phone width.
    await page.goto(`${base}/ui/projects/website`);
    await expect(page.getByRole('article', { name: /^GitHub/ })).toContainText('Connected');
    await page.getByRole('article', { name: /^Jira/ }).getByRole('button', { name: 'Manage' }).click();
    await expect(page.getByRole('form', { name: 'Which tickets' }).getByLabel('in column')).toHaveValue('Ready for agents');
    await expect(page.getByRole('form', { name: 'Which tickets' }).getByLabel('Pick up tickets from project')).toHaveValue('WEB · Website');
    await expect(page.getByRole('form', { name: 'Which tickets' }).getByRole('status').first()).toContainText('Matches 3 tickets now');
    await page.screenshot({ path: join(shots, 'u8-integrations-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: join(shots, 'u8-integrations-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1360, height: 900 });

    // Disconnecting asks once and forgets the connection.
    const panel = page.getByRole('region', { name: 'Jira connection' });
    await panel.getByRole('button', { name: 'Disconnect' }).click();
    await expect(panel).toContainText('The token stays saved for project fixture.');
    await panel.getByRole('button', { name: 'Yes, disconnect Jira' }).click();
    await expect(page.getByRole('article', { name: /^Jira/ })).toContainText('Not connected');
    expect((await (await fetch(integrations, { headers })).json() as { jira: unknown }).jira).toBeNull();
  } finally {
    for (const project of ['website', 'fixture']) for (const kind of ['github', 'jira']) await fetch(`${base}/projects/${project}/integrations/${kind}`, { method: 'DELETE', headers });
  }
});
