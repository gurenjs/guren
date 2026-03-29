import { test as setup, expect } from '@playwright/test'

const AUTH_FILE = 'e2e/.auth/user.json'

setup('authenticate', async ({ page }) => {
  await page.goto('/login')
  await expect(page.getByRole('heading', { name: 'Sign in to your account' })).toBeVisible()
  const emailInput = page.getByLabel('Email address')
  const passwordInput = page.getByLabel('Password')
  await emailInput.click()
  await emailInput.pressSequentially('demo@guren.dev')
  await expect(emailInput).toHaveValue('demo@guren.dev')
  await passwordInput.click()
  await passwordInput.pressSequentially('secret')
  await expect(passwordInput).toHaveValue('secret')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()

  await page.context().storageState({ path: AUTH_FILE })
})
