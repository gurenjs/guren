import { test, expect } from '@playwright/test'
import { gotoHydrated } from './helpers.js'

test.describe('Registration', () => {
  test.describe.configure({ mode: 'serial' })

  test('register page renders the sign-up form', async ({ page }) => {
    await gotoHydrated(page, '/register')

    await expect(page.getByRole('heading', { name: 'Create an account' })).toBeVisible()
    await expect(page.getByLabel('Name')).toBeVisible()
    await expect(page.getByLabel('Email address')).toBeVisible()
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible()
    await expect(page.getByLabel('Confirm password')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Create account' })).toBeVisible()
  })

  test('registering with valid details redirects to email verification', async ({ page }) => {
    const email = `register-${Date.now()}@example.com`

    await gotoHydrated(page, '/register')
    await page.getByLabel('Name').fill('New Author')
    await page.getByLabel('Email address').fill(email)
    await page.getByLabel('Password', { exact: true }).fill('password123')
    await page.getByLabel('Confirm password').fill('password123')
    await page.getByRole('button', { name: 'Create account' }).click()

    await expect(page).toHaveURL(/\/verify-email$/)
    await expect(page.getByRole('heading', { name: 'Verify your email' })).toBeVisible()
  })

  test('an unverified account is redirected away from /dashboard', async ({ page }) => {
    const email = `register-gate-${Date.now()}@example.com`

    await gotoHydrated(page, '/register')
    await page.getByLabel('Name').fill('Gate Check')
    await page.getByLabel('Email address').fill(email)
    await page.getByLabel('Password', { exact: true }).fill('password123')
    await page.getByLabel('Confirm password').fill('password123')
    await page.getByRole('button', { name: 'Create account' }).click()
    await expect(page).toHaveURL(/\/verify-email$/)

    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/verify-email$/)
  })

  test('registering with an already-used email shows a validation error', async ({ page }) => {
    await gotoHydrated(page, '/register')
    await page.getByLabel('Name').fill('Duplicate Demo')
    await page.getByLabel('Email address').fill('demo@guren.dev')
    await page.getByLabel('Password', { exact: true }).fill('password123')
    await page.getByLabel('Confirm password').fill('password123')
    await page.getByRole('button', { name: 'Create account' }).click()

    await expect(page).toHaveURL(/\/register/)
    await expect(page.getByText('An account with this email already exists.')).toBeVisible()
  })

  test('mismatched password confirmation shows a validation error', async ({ page }) => {
    await gotoHydrated(page, '/register')
    await page.getByLabel('Name').fill('Mismatch Case')
    await page.getByLabel('Email address').fill(`mismatch-${Date.now()}@example.com`)
    await page.getByLabel('Password', { exact: true }).fill('password123')
    await page.getByLabel('Confirm password').fill('different456')
    await page.getByRole('button', { name: 'Create account' }).click()

    await expect(page).toHaveURL(/\/register/)
    await expect(page.getByText('Passwords do not match.')).toBeVisible()
  })

  test('login page links to the registration page', async ({ page }) => {
    await gotoHydrated(page, '/login')
    await page.getByRole('link', { name: 'Sign up' }).click()
    await expect(page).toHaveURL(/\/register/)
  })
})
