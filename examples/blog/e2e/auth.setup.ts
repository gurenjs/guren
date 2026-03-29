import { test as setup, expect } from '@playwright/test'

const AUTH_FILE = 'e2e/.auth/user.json'

setup('authenticate', async ({ page }) => {
  await page.goto('/login')
  await expect(page.getByRole('heading', { name: 'Sign in to your account' })).toBeVisible()
  await page.getByLabel('Email address').fill('demo@guren.dev')
  await page.getByLabel('Password').fill('secret')
  await Promise.all([
    page.waitForURL('**/dashboard'),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ])
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()

  await page.context().storageState({ path: AUTH_FILE })
})
