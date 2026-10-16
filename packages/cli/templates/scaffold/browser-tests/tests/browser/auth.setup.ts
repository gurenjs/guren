import { expect, test as setup } from '@playwright/test'
import { AUTH_FILE, BROWSER_ACCOUNT_EMAIL, browserTestPassword } from './support'

// The labels are the ones `guren make:auth` writes into resources/js/pages/auth/Login.tsx; edit them with the page.
setup('sign in as the browser account', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Email').fill(BROWSER_ACCOUNT_EMAIL)
  await page.getByLabel('Password').fill(browserTestPassword())
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).not.toHaveURL(/\/login(?:[?#]|$)/u)
  await page.context().storageState({ path: AUTH_FILE })
})
