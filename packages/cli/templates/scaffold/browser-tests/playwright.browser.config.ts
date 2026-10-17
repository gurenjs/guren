import { existsSync } from 'node:fs'
import { defineConfig, devices } from '@playwright/test'

/** Away from the dev server's port, so a run never meets `bun run dev`. */
const PORT = 4317
const ORIGIN = `http://127.0.0.1:${PORT}`

// Playwright loads no .env. These are the files Bun loads for the app, most specific first; a value already set wins.
if (typeof process.loadEnvFile !== 'function') throw new Error(`The browser tests need Node 20.12 or later to load .env; this is Node ${process.version}.`)
const mode = process.env.NODE_ENV || 'development'
for (const file of ['.env.local', `.env.${mode}`, '.env']) {
  if (existsSync(file)) process.loadEnvFile(file)
}

// `guren browser:record --begin` names runs this way; the name becomes a path under .guren/browser/.
const RUN_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-[a-z0-9-]+$/u
const run = process.env.GUREN_BROWSER_RUN
if (run && (!RUN_NAME.test(run) || !existsSync(`.guren/browser/${run}/run.json`))) {
  throw new Error(`GUREN_BROWSER_RUN=${run} names no run guren browser:record --begin opened.`)
}

export default defineConfig({
  testDir: './tests/browser',
  // `bun test` collects *.test.ts and *.spec.ts, so a browser spec under either name would run there too.
  testMatch: '**/*.browser.ts',
  // One at a time: every spec drives the same app on the same local database.
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
