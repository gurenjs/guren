import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'

/** Written by the setup project and git-ignored: it holds a session cookie. */
export const AUTH_FILE = 'tests/browser/.auth/user.json'

/** The account db/seeders/browser-account.ts writes while `guren browser:serve` runs the app. */
export const BROWSER_ACCOUNT_EMAIL = 'browser@example.test'

/** The seeder reads the password from the app's `.env`, which Playwright does not load, so this reads it there too. */
export function browserTestPassword(): string {
  const fromEnv = process.env.BROWSER_TEST_PASSWORD
  if (fromEnv) return fromEnv
  let dotenv = ''
  try {
    dotenv = readFileSync('.env', 'utf8')
  } catch {
    dotenv = ''
  }
  const value = /^\s*BROWSER_TEST_PASSWORD=(.*)$/mu.exec(dotenv)?.[1]?.trim().replace(/^(['"])(.*)\1$/u, '$2')
  if (!value) throw new Error('Set BROWSER_TEST_PASSWORD in .env: the browser account is seeded with it, and nothing signs in without it.')
  return value
}

/** The component the server rendered, read from the Inertia initial page as `guren browser:doctor` reads it. */
export async function initialComponent(page: Page): Promise<string | undefined> {
  const raw = await page.evaluate(() => {
    const script = document.querySelector('script[data-page="app"][type="application/json"]')
    return script?.textContent ?? document.querySelector('[data-page]')?.getAttribute('data-page') ?? null
  })
  if (!raw) return undefined
  try {
    const component = (JSON.parse(raw) as { component?: unknown }).component
    return typeof component === 'string' ? component : undefined
  } catch {
    return undefined
  }
}
