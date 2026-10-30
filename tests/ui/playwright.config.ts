import { defineConfig } from '@playwright/test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Browser workflow tests run against the labelled development fixture service (deterministic fake
// engine, temporary data directory). They never need model credentials. Build first: npm run build.
export const fixtureDir = process.env.DEVAGENTS_UI_FIXTURE_DIR ?? join(tmpdir(), 'devagents-ui-fixture-playwright');
export const port = Number(process.env.DEVAGENTS_UI_FIXTURE_PORT ?? 4399);
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  timeout: 60000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: join(tmpdir(), 'devagents-ui-test-results'),
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1360, height: 900 }, trace: 'retain-on-failure' },
  webServer: {
    command: `node scripts/ui-fixture.mjs --port ${port} --data "${fixtureDir}" --hold 600000`,
    url: `http://127.0.0.1:${port}/health`,
    cwd: join(import.meta.dirname, '..', '..'),
    reuseExistingServer: false,
    timeout: 120000,
    stdout: 'ignore', stderr: 'pipe',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
