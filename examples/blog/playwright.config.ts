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
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: 'unauthenticated',
      testMatch: /(auth|registration|password-reset)\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
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
    // Not `dev:server`: that runs under `bun --hot`, and a test run must hold
    // still. `CI=1` drops the cookie `Secure` flag, without which Inertia's XHR
    // POSTs fail over plain HTTP. GUREN_STRICT_PORT=1 pins the port — otherwise
    // the entrypoint walks past a busy 3333 while `baseURL` still points at it.
    command: isCI ? 'CI=1 GUREN_STRICT_PORT=1 bun run e2e:server' : 'GUREN_STRICT_PORT=1 bun run dev',
    url: 'http://localhost:3333',
    // With `!isCI` a run attached to whatever was already on 3333 and reported
    // it as this branch's result. The cost is stopping `bun run dev` first.
    reuseExistingServer: false,
    timeout: isCI ? 60_000 : 30_000,
  },
})
