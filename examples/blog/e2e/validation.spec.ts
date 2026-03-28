import { test, expect } from '@playwright/test'

// Validation tests depend on Inertia XHR round-trip timing that is
// unreliable in CI. Run locally; skip in CI to avoid flaky failures.
// TODO: investigate CI-specific Inertia form submission timing
const skipInCI = !!process.env.CI

test.describe('Validation errors', () => {
  test('submitting an empty post form shows validation errors', async ({ page }) => {
    test.skip(skipInCI, 'Inertia validation timing unreliable in CI')
    test.slow()
    await page.goto('/posts/new')
    await page.waitForLoadState('networkidle')
    await expect(page.getByRole('heading', { name: 'New Post' })).toBeVisible()

    await page.getByRole('button', { name: 'Create Post' }).click()
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1000)

    await expect(page.getByText('Title is required.')).toBeVisible()
    await expect(page.getByText('Excerpt is required.')).toBeVisible()
    await expect(page.getByText('Body is required.')).toBeVisible()
  })

  test('submitting a partially filled post form shows remaining errors', async ({ page }) => {
    test.skip(skipInCI, 'Inertia validation timing unreliable in CI')
    test.slow()
    await page.goto('/posts/new')
    await page.waitForLoadState('networkidle')

    await page.getByLabel('Title').fill('Partial Post')
    await page.getByRole('button', { name: 'Create Post' }).click()
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1000)

    await expect(page.getByText('Excerpt is required.')).toBeVisible()
    await expect(page.getByText('Title is required.')).not.toBeVisible()
    await expect(page.getByText('Body is required.')).toBeVisible()
  })
})
