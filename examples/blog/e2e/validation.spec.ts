import { test, expect, type Page } from '@playwright/test'

async function login(page: Page) {
  await page.goto('/login')
  await page.waitForLoadState('networkidle')
  await page.getByLabel('Email address').fill('demo@guren.dev')
  await page.getByLabel('Password').fill('secret')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/dashboard')
}

test.describe('Validation errors', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('submitting an empty post form shows validation errors', async ({ page }) => {
    await page.goto('/posts/new')
    await page.waitForLoadState('networkidle')
    await expect(page.getByRole('heading', { name: 'New Post' })).toBeVisible()

    // Submit the form — Inertia sends XHR, server returns validation errors
    await page.getByRole('button', { name: 'Create Post' }).click()
    await page.waitForLoadState('networkidle')

    await expect(page.getByText('Title is required.')).toBeVisible()
    await expect(page.getByText('Excerpt is required.')).toBeVisible()
    await expect(page.getByText('Body is required.')).toBeVisible()
  })

  test('submitting a partially filled post form shows remaining errors', async ({ page }) => {
    await page.goto('/posts/new')
    await page.waitForLoadState('networkidle')

    // Fill only the title
    await page.getByLabel('Title').fill('Partial Post')
    await page.getByRole('button', { name: 'Create Post' }).click()
    await page.waitForLoadState('networkidle')

    await expect(page.getByText('Excerpt is required.')).toBeVisible()

    // Title error should not appear, but excerpt and body errors should
    await expect(page.getByText('Title is required.')).not.toBeVisible()
    await expect(page.getByText('Body is required.')).toBeVisible()
  })
})
