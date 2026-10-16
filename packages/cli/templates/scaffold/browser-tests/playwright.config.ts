import { defineConfig, devices } from '@playwright/test'

/** Away from the dev server's port, so a run never meets `bun run dev`. */
const PORT = 4317
const ORIGIN = `http://127.0.0.1:${PORT}`

// `guren browser:record --begin` names runs this way; any other value could write outside .guren/browser/.
const RUN_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-[a-z0-9-]+$/u
const run = process.env.GUREN_BROWSER_RUN
if (run && !RUN_NAME.test(run)) throw new Error(`GUREN_BROWSER_RUN=${run} is not a run name guren browser:record --begin wrote.`)

export default defineConfig({
  testDir: './tests/browser',
  // `bun test` collects *.test.ts and *.spec.ts, so a browser spec under either name would run there too.
  testMatch: '**/*.browser.ts',
  workers: 1,
  reporter: run ? [['list'], ['json', { outputFile: `.guren/browser/${run}/spec-report.json` }]] : 'list',
  use: {
    baseURL: ORIGIN,
    trace: 'off',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts$/u },
    { name: 'chromium', dependencies: ['setup'], use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    // browser:serve refuses production and a database it cannot show is local, and stops only the app it started.
    command: `bunx guren browser:serve --port ${PORT}`,
    url: ORIGIN,
    reuseExistingServer: false,
    timeout: 120_000,
    // Playwright otherwise SIGKILLs browser:serve's group, which the app's own process group survives.
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
  },
})
