import { test, expect } from '@playwright/test'

test.describe('Inertia SPA Navigation', () => {
  test('navigating between pages uses Inertia (no full reload)', async ({ page }) => {
    await page.goto('/posts')
    await expect(page.getByRole('heading', { name: 'Posts' })).toBeVisible()
    await expect(page.locator('main[data-hydrated="true"]')).toBeVisible()

    const firstPostLink = page.locator('article a').first()
    const firstPostTitle = await firstPostLink.locator('h2').textContent()
    await Promise.all([
      page.waitForURL(/\/posts\/\d+$/),
      firstPostLink.click(),
    ])

    await expect(page).toHaveURL(/\/posts\/\d+/)
    await expect(page.getByRole('link', { name: 'Back to posts' })).toBeVisible()
    if (firstPostTitle) {
      await expect(page.getByRole('heading', { name: firstPostTitle.trim() })).toBeVisible()
    }
  })
})

test.describe('Pagination', () => {
  test('pagination navigates between pages', async ({ page }) => {
    await page.goto('/posts')
    await expect(page.getByRole('heading', { name: 'Posts' })).toBeVisible()
    await expect(page.locator('main[data-hydrated="true"]')).toBeVisible()

    const nextLink = page.getByRole('link', { name: 'Next' })
    if (await nextLink.isVisible()) {
      await Promise.all([
        page.waitForURL(/page=2/),
        nextLink.click(),
      ])
      await expect(page).toHaveURL(/page=2/)

      const prevLink = page.getByRole('link', { name: 'Previous' })
      if (await prevLink.isVisible()) {
        await Promise.all([
          page.waitForURL(/\/posts(?:\?.*)?$/),
          prevLink.click(),
        ])
        await expect(page).toHaveURL(/\/posts/)
      }
    }
  })
})

test.describe('Multi-step User Journey', () => {
  test('dashboard → create post → view post', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
    await expect(page.locator('main[data-hydrated="true"]')).toBeVisible()

    await Promise.all([
      page.waitForURL('**/posts'),
      page.getByRole('link', { name: 'Posts' }).click(),
    ])
    await expect(page.getByRole('heading', { name: 'Posts' })).toBeVisible()
    await expect(page.locator('main[data-hydrated="true"]')).toBeVisible()

    await Promise.all([
      page.waitForURL('**/posts/new'),
      page.getByRole('link', { name: 'New post' }).click(),
    ])
    await expect(page.getByRole('heading', { name: 'New Post' })).toBeVisible()
    await expect(page.locator('main[data-hydrated="true"]')).toBeVisible()

    const title = `Journey Post ${Date.now()}`
    await page.getByLabel('Title').fill(title)
    await page.getByLabel('Excerpt').fill('Journey test excerpt')
    await page.getByLabel('Body').fill('Journey test body')
    await expect(page.getByLabel('Title')).toHaveValue(title)
    await page.getByRole('button', { name: 'Create Post' }).click()
    await expect(page).toHaveURL(/\/posts(?:\/\d+)?$/)

    await expect(page.getByText(title)).toBeVisible()
  })
})
