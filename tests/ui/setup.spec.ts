import { test, expect, type Page } from '@playwright/test';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fixture } from '../helpers.js';
import { createApi } from '../../src/api/server.js';
import { SetupAuth } from '../../src/setup/auth.js';
import { statusLimits } from '../../src/api/status.js';
import { Config } from '../../src/domain/schemas.js';
import type { AuthStatus } from '../../src/domain/auth.js';

test('browser connects through a session-owned device flow, saves a key without browser persistence and selects a starter team', async ({ page }) => {
  const f = await fixture(); let saved: AuthStatus = { saved: false }; let finish: (() => void) | undefined; const keys: string[] = []; let calls = 0;
  const setup = new SetupAuth({ status: async () => saved, login: async (method, key, signal, challenge) => {
    calls++;
    if (method === 'chatgpt') {
      challenge({ url: 'https://auth.openai.com/codex/device', code: 'ABCD-12345' });
      await new Promise<void>((resolve, reject) => { finish = resolve; signal.addEventListener('abort', () => reject(new Error('cancelled'))); });
    } else keys.push(key!);
    saved = { saved: true, method };
  } });
  await f.service.initializeStarterTeam();
  const server = createApi(f.service, 'synthetic-setup-token', { setupAuth: setup, uiRoot: resolve('dist/ui'), status: async () => ({
    service: { version: 'fixture', platform: 'fixture', executionEnabled: false, startedAt: new Date().toISOString() },
    codex: { installed: true, version: 'fixture', signedIn: saved.saved, vaultLocked: false, credentialStore: 'file', modelAccessVerified: false },
    defaults: { engine: 'codex', provider: 'openai', model: null, providers: [] }, claude: { enabled: false, installed: false, note: 'Unavailable' }, limits: statusLimits(Config.parse({ schemaVersion: 1 })), fixture: { label: 'Synthetic sign-in; no credentials or model calls' },
  }) });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const signIn = async (p: Page) => { const r = await fetch(origin + '/ui/bootstrap', { method: 'POST', headers: { authorization: 'Bearer synthetic-setup-token', 'content-type': 'application/json' }, body: '{"setup":true}' }); await p.goto((await r.json()).url); };
  try {
    await signIn(page);
    await expect(page).toHaveURL(origin + '/ui/settings/setup');
    await expect(page.getByRole('button', { name: 'Claude · coming later' })).toBeDisabled();
    await page.getByRole('button', { name: 'Sign in with ChatGPT', exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await expect(page.getByRole('link', { name: 'Open ChatGPT sign-in' })).toHaveAttribute('href', 'https://auth.openai.com/codex/device');
    await expect(page.getByText('ABCD-12345', { exact: true })).toBeVisible(); expect(calls).toBe(1);
    await page.reload(); await expect(page.getByText('ABCD-12345', { exact: true })).toBeVisible(); expect(calls).toBe(1);
    finish!(); await expect(page.getByText('Connection saved', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Use an OpenAI API key', exact: true }).click();
    await page.getByLabel('OpenAI API key', { exact: true }).fill('synthetic-key-not-a-credential');
    await page.getByRole('button', { name: 'Save connection', exact: true }).click();
    await expect(page.getByText(/Saved method: api-key/)).toBeVisible();
    expect(keys).toEqual(['synthetic-key-not-a-credential']);
    await expect(page.locator('input[type=password]')).toHaveCount(0);
    expect(await page.evaluate(() => JSON.stringify({ session: { ...sessionStorage }, local: { ...localStorage }, body: document.body.innerText }))).not.toContain('synthetic-key-not-a-credential');
    await expect(page.getByRole('button', { name: 'Use recommended team', exact: true })).toBeDisabled();
    await expect(page.getByText('Starter team selected for fixture.', { exact: true })).toBeVisible();
    expect(f.store.project('fixture').defaultTeamId).toBeTruthy();
    await expect(page.getByText('Codex signed in · model access not verified', { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await mkdir(resolve('test-results/ui-screenshots'), { recursive: true });
    await page.screenshot({ path: resolve('test-results/ui-screenshots/setup-connected-narrow.png'), fullPage: true });
    await page.getByRole('button', { name: 'Sign in with ChatGPT', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Cancel sign-in', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel sign-in', exact: true }).click();
    await expect(page.getByText('cancelled', { exact: true })).toBeVisible();
  } finally { await setup.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.cleanup(); }
});
