import { defineConfig, devices } from '@playwright/test'

/**
 * Drives the static prototype build (RFC 0021) with the Bun server stopped:
 * once from the site root and once from a `/blog/` subpath, the two hosting
 * shapes the build promises. `scripts/smoke/prototype-blog.ts` produces both
 * builds; this config only serves and tests them.
 */
const isCI = !!process.env.CI

export default defineConfig({
  testDir: './e2e/prototype',
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: 1,
  timeout: isCI ? 60_000 : 30_000,
  expect: { timeout: isCI ? 15_000 : 5_000 },
  reporter: isCI ? 'github' : 'list',
  use: {
    trace: 'on-first-retry',
    navigationTimeout: isCI ? 30_000 : 15_000,
  },
  projects: [
    {
      name: 'root',
      use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:3334' },
    },
    {
      name: 'subpath',
      use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:3335/blog' },
    },
  ],
  webServer: [
    {
      command: 'PORT=3334 bun e2e/prototype/serve.ts',
      url: 'http://127.0.0.1:3334/',
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'PORT=3335 PROTOTYPE_BASE=/blog/ PROTOTYPE_DIR=dist/prototype-blog bun e2e/prototype/serve.ts',
      url: 'http://127.0.0.1:3335/blog/',
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
})
