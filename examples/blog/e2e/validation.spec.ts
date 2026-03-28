import { test, expect, type Page } from '@playwright/test'

async function login(page: Page) {
  await page.goto('/login')
  await page.waitForLoadState('networkidle')
  await page.getByLabel('Email address').fill('demo@guren.dev')
  await page.getByLabel('Password').fill('secret')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/dashboard', { timeout: 15_000 })
}

test.describe('Validation errors', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('submitting an empty post form shows validation errors', async ({ page }) => {
    await page.goto('/posts/new')
    await page.waitForLoadState('networkidle')
    await expect(page.getByRole('heading', { name: 'New Post' })).toBeVisible()

    // Submit the form without filling in any fields — wait for Inertia XHR response
    await Promise.all([
      page.waitForResponse((res) => res.url().includes('/posts')),
      page.getByRole('button', { name: 'Create Post' }).click(),
    ])

    await expect(page.getByText('Title is required.')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('Excerpt is required.')).toBeVisible()
    await expect(page.getByText('Body is required.')).toBeVisible()
  })

  test('submitting a partially filled post form shows remaining errors', async ({ page }) => {
    await page.goto('/posts/new')
    await page.waitForLoadState('networkidle')

    // Fill only the title
    await page.getByLabel('Title').fill('Partial Post')
    await Promise.all([
      page.waitForResponse((res) => res.url().includes('/posts')),
      page.getByRole('button', { name: 'Create Post' }).click(),
    ])

    // Wait for Inertia error response
    await expect(page.getByText('Excerpt is required.')).toBeVisible({ timeout: 15_000 })

    // Title error should not appear, but excerpt and body errors should
    await expect(page.getByText('Title is required.')).not.toBeVisible()
    await expect(page.getByText('Body is required.')).toBeVisible()
  })
})
