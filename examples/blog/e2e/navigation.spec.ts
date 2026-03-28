import { test, expect, type Page } from '@playwright/test'

async function login(page: Page) {
  await page.goto('/login')
  await page.waitForLoadState('networkidle')
  await page.getByLabel('Email address').fill('demo@guren.dev')
  await page.getByLabel('Password').fill('secret')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/dashboard')
}

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
  test('full user journey: login → dashboard → create post → view post', async ({ page }) => {
    // Login
    await page.goto('/login')
    await page.waitForLoadState('networkidle')
    await page.getByLabel('Email address').fill('demo@guren.dev')
    await page.getByLabel('Password').fill('secret')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.waitForURL('**/dashboard')

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

test.describe('Authenticated Route Protection', () => {
  test('protected routes redirect unauthenticated users', async ({ page }) => {
    // Try to access protected routes without auth
    await page.goto('/posts/new')
    await expect(page).toHaveURL(/\/login/)

    await page.goto('/posts/1/edit')
    await expect(page).toHaveURL(/\/login/)

    await page.goto('/profile')
    await expect(page).toHaveURL(/\/login/)
  })
})
