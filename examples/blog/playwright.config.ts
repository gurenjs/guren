import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 3 : 0,
  workers: 1,
  timeout: process.env.CI ? 60_000 : 30_000,
  expect: { timeout: process.env.CI ? 15_000 : 5_000 },
  reporter: process.env.CI ? 'github' : 'html',
  use: {
    baseURL: 'http://localhost:3333',
    trace: 'on-first-retry',
    navigationTimeout: process.env.CI ? 30_000 : 15_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: process.env.CI ? 'bun run dev:server' : 'bun run dev',
    url: 'http://localhost:3333',
    reuseExistingServer: !process.env.CI,
    timeout: process.env.CI ? 60_000 : 30_000,
  },
})
