import { defineConfig, devices } from '@playwright/test'

const isCI = !!process.env.CI

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 3 : 0,
  workers: 1,
  timeout: isCI ? 60_000 : 30_000,
  expect: { timeout: isCI ? 15_000 : 5_000 },
  reporter: isCI ? 'github' : 'html',
  use: {
    baseURL: 'http://localhost:3333',
    trace: 'on-first-retry',
    navigationTimeout: isCI ? 30_000 : 15_000,
  },
  projects: [
    // Setup: login once and save session
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
    },
    // Auth + route protection tests run without saved session
    {
      name: 'unauthenticated',
      testMatch: /(auth|registration|password-reset)\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    // Tests that need an authenticated session
    {
      name: 'authenticated',
      testMatch: /(posts-crud|validation|navigation)\.spec\.ts/,
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'e2e/.auth/user.json',
      },
    },
  ],
  webServer: {
    // Not `dev:server` — that runs under `bun --hot`, which belongs to local
    // development, not a test run that should hold still.
    // `CI=1` is passed explicitly: the server reads it to drop the cookie
    // `Secure` flag, without which Inertia's XHR POSTs fail over plain HTTP.
    command: isCI ? 'CI=1 bun run e2e:server' : 'bun run dev',
    url: 'http://localhost:3333',
    reuseExistingServer: !isCI,
    timeout: isCI ? 60_000 : 30_000,
  },
})
