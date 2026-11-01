import { expect, test as setup } from '@playwright/test'
import { AUTH_FILE, BROWSER_ACCOUNT_EMAIL, browserTestPassword, initialComponent } from './support'

// The labels are the ones `guren make:auth` writes into resources/js/pages/auth/Login.tsx; edit them with the page.
setup('sign in as the browser account', async ({ page }) => {
  // Filled before React hydrates, the form is reset to empty by hydration and submits nothing.
  await page.goto('/login', { waitUntil: 'networkidle' })
  await page.getByLabel('Email').fill(BROWSER_ACCOUNT_EMAIL)
  await page.getByLabel('Password').fill(browserTestPassword())
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).not.toHaveURL(/\/login(?:[?#]|$)/u)
  // A fresh load, so the initial page names where the sign-in landed: an auth page (verify email, two factors) is no session to save.
  await page.reload()
  expect(await initialComponent(page)).not.toMatch(/^auth\//u)
  // The server reads a locale cookie ahead of the config's `locale`, so one set at sign-in would carry into every signed-in spec.
  // `locale` is the name unless createApp({ i18n: { detect: { cookieName } } }) renames it.
  await page.context().clearCookies({ name: 'locale' })
  await page.context().storageState({ path: AUTH_FILE })
})
