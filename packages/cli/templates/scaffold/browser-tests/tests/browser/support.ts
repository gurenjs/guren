import type { Page } from '@playwright/test'

/** Written by the setup project and git-ignored: it holds a session cookie. */
export const AUTH_FILE = 'tests/browser/.auth/user.json'

/** The account db/seeders/browser-account.ts writes while `guren browser:serve` runs the app. */
export const BROWSER_ACCOUNT_EMAIL = 'browser@example.test'

/** Loaded from the app's env files by playwright.browser.config.ts, as the seeder reads it. */
export function browserTestPassword(): string {
  const password = process.env.BROWSER_TEST_PASSWORD
  if (!password) throw new Error('Set BROWSER_TEST_PASSWORD in .env: the browser account is seeded with it, and nothing signs in without it.')
  return password
}

/**
 * The component the server rendered, read from the Inertia initial page as `guren browser:doctor`
 * reads it. Only a full load writes that page: after a client-side visit it still names the first one.
 */
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
