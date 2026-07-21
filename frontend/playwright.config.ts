import { defineConfig, devices } from '@playwright/test';

const e2eBaseUrl = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3100';
const browserChannel = process.env.PLAYWRIGHT_CHANNEL as 'chrome' | undefined;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: e2eBaseUrl,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(browserChannel ? { channel: browserChannel } : {}),
      },
    },
  ],
  webServer: {
    command: 'npm run dev -- -p 3100',
    url: e2eBaseUrl,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
