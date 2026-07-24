import { test, expect } from '@playwright/test'
import { gotoHydrated } from './helpers.js'

const STATUS_MESSAGE = "If an account exists for that email, we've sent a password reset link."

test.describe('Password reset', () => {
  test.describe.configure({ mode: 'serial' })

  test('forgot-password page renders the request form', async ({ page }) => {
    await gotoHydrated(page, '/forgot-password')

    await expect(page.getByRole('heading', { name: 'Forgot your password?' })).toBeVisible()
    await expect(page.getByLabel('Email address')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Send reset link' })).toBeVisible()
  })

  test('shows the same status message for a known account', async ({ page }) => {
    await gotoHydrated(page, '/forgot-password')
    await page.getByLabel('Email address').fill('demo@guren.dev')
    await page.getByRole('button', { name: 'Send reset link' }).click()

    await expect(page.getByText(STATUS_MESSAGE)).toBeVisible()
  })

  test('shows the same status message for an unknown account (no enumeration)', async ({ page }) => {
    await gotoHydrated(page, '/forgot-password')
    await page.getByLabel('Email address').fill('nobody-at-all@example.com')
    await page.getByRole('button', { name: 'Send reset link' }).click()

    await expect(page.getByText(STATUS_MESSAGE)).toBeVisible()
  })

  test('login page links to the forgot-password page', async ({ page }) => {
    await gotoHydrated(page, '/login')
    await page.getByRole('link', { name: 'Forgot password?' }).click()
    await expect(page).toHaveURL(/\/forgot-password/)
  })

  test('reset-password page renders with the token and email from the link', async ({ page }) => {
    await gotoHydrated(page, '/reset-password?token=e2e-fake-token&email=demo@guren.dev')

    await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible()
    await expect(page.getByText('Choose a new password for demo@guren.dev.')).toBeVisible()
  })

  test('submitting an invalid or expired token shows an error', async ({ page }) => {
    await gotoHydrated(page, '/reset-password?token=e2e-fake-token&email=demo@guren.dev')
    await page.getByLabel('New password', { exact: true }).fill('newpassword123')
    await page.getByLabel('Confirm new password').fill('newpassword123')
    await page.getByRole('button', { name: 'Reset password' }).click()

    await expect(page).toHaveURL(/\/reset-password/)
    await expect(page.getByText('This password reset link is invalid or has expired.')).toBeVisible()
  })
})
