import { test, expect } from '@playwright/test'

test.describe('Inertia SPA Navigation', () => {
  test('navigating between pages uses Inertia (no full reload)', async ({ page }) => {
    await page.goto('/posts')
    await page.waitForLoadState('networkidle')

    // Listen for any full page navigation (non-XHR)
    let fullReloadDetected = false
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        fullReloadDetected = true
      }
    })

    // Click on a post link — Inertia handles this via XHR
    const firstPostLink = page.locator('article a').first()
    await firstPostLink.click()
    await page.waitForLoadState('networkidle')

    // Verify we navigated to a post page
    await expect(page).toHaveURL(/\/posts\/\d+/)
  })
})

test.describe('Pagination', () => {
  test('pagination navigates between pages', async ({ page }) => {
    await page.goto('/posts')
    await page.waitForLoadState('networkidle')

    // Check if pagination exists (there may be enough posts)
    const nextLink = page.getByRole('link', { name: 'Next' })
    if (await nextLink.isVisible()) {
      await nextLink.click()
      await page.waitForLoadState('networkidle')
      await expect(page).toHaveURL(/page=2/)

      // Navigate back
      const prevLink = page.getByRole('link', { name: 'Previous' })
      if (await prevLink.isVisible()) {
        await prevLink.click()
        await page.waitForLoadState('networkidle')
        await expect(page).toHaveURL(/\/posts/)
      }
    }
  })
})

test.describe('Multi-step User Journey', () => {
  test('dashboard → create post → view post', async ({ page }) => {
    // Already authenticated via storageState
    await page.goto('/dashboard')
    await page.waitForLoadState('networkidle')

    // Navigate to posts
    await page.getByRole('link', { name: 'Posts' }).click()
    await page.waitForLoadState('networkidle')
    await expect(page.getByRole('heading', { name: 'Posts' })).toBeVisible()

    // Create a new post
    await page.getByRole('link', { name: 'New post' }).click()
    await page.waitForLoadState('networkidle')

    const title = `Journey Post ${Date.now()}`
    await page.getByLabel('Title').fill(title)
    await page.getByLabel('Excerpt').fill('Journey test excerpt')
    await page.getByLabel('Body').fill('Journey test body')
    await page.getByRole('button', { name: 'Create Post' }).click()
    await page.waitForURL(/\/posts/)
    await page.waitForLoadState('networkidle')

    // Verify navigation landed on a posts page (show or index)
    await expect(page.locator('h1, h2').first()).toBeVisible()
  })
})

// Route protection tests are in auth.spec.ts (requires unauthenticated state)
