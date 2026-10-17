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
 * The component the server rendered: Guren's page shell sets `window.__INERTIA_PAGE__` from the same
 * element `guren browser:doctor` reads, which is parsed here when a CSP without the shell's nonce kept
 * that inline script from running. Only a full load writes either: after a client-side visit they
 * still name the first page.
 */
export async function initialComponent(page: Page): Promise<string | undefined> {
  return page.evaluate(() => {
    let initial = (window as Window & { __INERTIA_PAGE__?: { component?: unknown } }).__INERTIA_PAGE__
    if (!initial) {
      try {
        initial = JSON.parse(document.querySelector('script[data-page="app"][type="application/json"]')?.textContent ?? 'null')
      } catch {
        initial = undefined
      }
    }
    return typeof initial?.component === 'string' ? initial.component : undefined
  })
}
