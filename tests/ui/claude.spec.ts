import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { fixture } from '../helpers.js';
import { SetupAuth } from '../../src/setup/auth.js';
import { TaskService } from '../../src/orchestration/service.js';
import { createApi } from '../../src/api/server.js';
import { statusLimits } from '../../src/api/status.js';
import type { AuthStatus } from '../../src/domain/auth.js';

test('Claude connection forms save both credential types privately and members select compatible engines/models', async ({ page }) => {
  const f = await fixture(); let saved: AuthStatus = { saved: false }; const methods: string[] = [];
  const claudeAuth = new SetupAuth({ status: async () => saved, login: async (method, secret) => { expect(secret).toBe('synthetic-credential'); methods.push(method); saved = { saved: true, method }; } });
  const service = new TaskService(f.store, f.service.config, f.dataDir, process.platform, new Set(['codex', 'claude-code']));
  const team = service.createTeam({ name: 'Mixed browser team', members: (await service.templates()).filter(a => ['tech-lead', 'general-developer', 'code-reviewer'].includes(a.id)) });
  const server = createApi(service, 'synthetic-browser-token', { claudeAuth, uiRoot: resolve('dist/ui'), status: async () => ({
    service: { version: 'fixture', platform: 'fixture', executionEnabled: false, startedAt: new Date().toISOString() },
    codex: { installed: true, version: 'fixture', signedIn: false, vaultLocked: false, credentialStore: 'file', modelAccessVerified: false },
    claude: { installed: true, enabled: true, signedIn: saved.saved, note: 'Fixture' },
    defaults: { engine: 'codex', provider: 'openai', model: null, providers: [] }, limits: statusLimits(service.config), fixture: { label: 'Synthetic authentication' },
  }) });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const response = await fetch(origin + '/ui/bootstrap', { method: 'POST', headers: { authorization: 'Bearer synthetic-browser-token', 'content-type': 'application/json' }, body: '{"setup":true}' });
    await page.goto((await response.json()).url);
    await page.goto(origin + '/ui/settings');
    await page.getByRole('link', { name: 'Set up / change Claude connection' }).click();
    await expect(page).toHaveURL(origin + '/ui/settings/claude');
    await page.getByRole('button', { name: 'Use my Claude subscription', exact: true }).click();
    await expect(page.getByText('claude setup-token', { exact: true })).toBeVisible();
    await page.getByLabel('Claude subscription token', { exact: true }).fill('synthetic-credential');
    await page.getByRole('button', { name: 'Save connection', exact: true }).click();
    await expect(page.getByText(/Saved method: subscription/)).toBeVisible();
    await page.getByRole('button', { name: 'Use an Anthropic API key', exact: true }).click();
    await page.getByLabel('Anthropic API key', { exact: true }).fill('synthetic-credential');
    await page.getByRole('button', { name: 'Save connection', exact: true }).click();
    await expect(page.getByText(/Saved method: api-key/)).toBeVisible();
    expect(methods).toEqual(['subscription', 'api-key']);
    expect(await page.evaluate(() => JSON.stringify({ body: document.body.innerText, local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain('synthetic-credential');
    await page.goto(`${origin}/ui/teams/${team.id}`);
    await page.getByRole('button', { name: /Developer from template general-developer/ }).first().click();
    const model = page.getByRole('combobox', { name: 'Model', exact: true });
    await expect(page.getByLabel(/^Provider/)).toHaveCount(0);
    await expect(page.getByLabel(/^Connection/)).toHaveCount(0);
    await model.selectOption('gpt-6-astra');
    await page.getByRole('button', { name: /Code Reviewer from template code-reviewer/ }).click();
    await model.selectOption('gpt-6.1-sol');
    await page.getByRole('button', { name: 'Save team', exact: true }).click();
    await expect.poll(() => service.team(team.id).members.find(m => m.id === 'general-developer')?.model).toBe('gpt-6-astra');
    expect(service.team(team.id).members.find(m => m.id === 'code-reviewer')?.model).toBe('gpt-6.1-sol');
    // Submission freezes the two different model choices before later edits.
    const task = service.submit({ projectId: 'fixture', teamId: team.id, request: 'Fixture only', mode: 'plan-approval' }, 'browser-models');
    await page.reload();
    await page.getByRole('button', { name: /Developer from template general-developer/ }).first().click();
    await expect(model).toHaveValue('gpt-6-astra');
    await page.getByRole('combobox', { name: /^Engine/ }).selectOption('claude-code');
    await expect(page.locator('.members').getByRole('img', { name: 'Engine: Claude', exact: true })).toHaveCount(1);
    await expect(page.locator('.members').getByRole('img', { name: 'Engine: Codex', exact: true })).toHaveCount(2);
    await expect(page.getByLabel(/^Provider/)).toHaveCount(0);
    await expect(page.getByLabel(/^Connection/)).toHaveCount(0);
    await expect(model).toHaveValue('default');
    await expect(model.locator('option[value="gpt-6-astra"]')).toHaveCount(0);
    for (const id of ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) await expect(model.locator(`option[value="${id}"]`)).toHaveCount(1);
    await model.selectOption('claude-sonnet-5-5');
    await page.getByRole('button', { name: 'Save team', exact: true }).click();
    await expect.poll(() => service.team(team.id).members.find(m => m.id === 'general-developer')?.model).toBe('claude-sonnet-5-5');
    expect(service.team(team.id).members.find(m => m.id === 'general-developer')?.provider).toBe('anthropic');
    await page.setViewportSize({ width: 390, height: 844 });
    await model.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: '/tmp/devagents-model-dropdown-mobile.png', fullPage: true });
    await model.selectOption('__custom__');
    await page.getByLabel('Custom model ID', { exact: true }).fill('claude-fixture-model');
    await page.getByRole('button', { name: 'Save team', exact: true }).click();
    await expect.poll(() => service.team(team.id).members.find(m => m.id === 'general-developer')?.model).toBe('claude-fixture-model');
    await page.reload();
    await page.getByRole('button', { name: /Developer from template general-developer/ }).first().click();
    await expect(model).toHaveValue('__custom__');
    await expect(page.getByLabel('Custom model ID', { exact: true })).toHaveValue('claude-fixture-model');
    await model.selectOption('default');
    await expect(page.getByLabel('Custom model ID', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Save team', exact: true }).click();
    await expect.poll(() => service.team(team.id).members.find(m => m.id === 'general-developer')?.model).toBe('default');
    expect(f.store.task(task.id).team!.members.find(m => m.id === 'general-developer')?.model).toBe('gpt-6-astra');
    expect(f.store.task(task.id).team!.members.find(m => m.id === 'code-reviewer')?.model).toBe('gpt-6.1-sol');
    expect(service.team(team.id).members.find(m => m.id === 'code-reviewer')?.engine).toBe('default');
    // Multiple real connections remain selectable under Advanced, without changing the model.
    service.config.providers.push({ id: 'openai-work', kind: 'openai', auth: 'api-key', apiKeyEnv: 'FIXTURE_ONLY_KEY' });
    await page.reload();
    await page.getByRole('button', { name: /Code Reviewer from template code-reviewer/ }).click();
    const connection = page.getByLabel(/^Connection/);
    await expect(connection).toBeHidden();
    await page.getByText('Advanced · capabilities, scope, commands, concurrency', { exact: true }).click();
    await connection.selectOption('openai-work');
    await page.getByRole('button', { name: 'Save team', exact: true }).click();
    await expect.poll(() => service.team(team.id).members.find(m => m.id === 'code-reviewer')?.provider).toBe('openai-work');
    expect(service.team(team.id).members.find(m => m.id === 'code-reviewer')?.model).toBe('gpt-6.1-sol');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}/ui/settings/setup`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  } finally { await claudeAuth.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await f.cleanup(); }
});
