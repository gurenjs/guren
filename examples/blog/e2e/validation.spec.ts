import { test, expect } from '@playwright/test'

test.describe('Validation errors', () => {
  test('submitting an empty post form shows validation errors', async ({ page }) => {
    await page.goto('/posts/new')
    await expect(page.getByRole('heading', { name: 'New Post' })).toBeVisible()
    await expect(page.locator('main[data-hydrated="true"]')).toBeVisible()

    await page.getByRole('button', { name: 'Create Post' }).click()

    await expect(page.getByText('Title is required.')).toBeVisible()
    await expect(page.getByText('Excerpt is required.')).toBeVisible()
    await expect(page.getByText('Body is required.')).toBeVisible()
  })

  test('submitting a partially filled post form shows remaining errors', async ({ page }) => {
    await page.goto('/posts/new')
    await expect(page.getByRole('heading', { name: 'New Post' })).toBeVisible()
    await expect(page.locator('main[data-hydrated="true"]')).toBeVisible()

    const titleInput = page.getByLabel('Title')
    await titleInput.click()
    await titleInput.pressSequentially('Partial Post')
    await expect(titleInput).toHaveValue('Partial Post')
    await page.getByRole('button', { name: 'Create Post' }).click()

    await expect(page.getByText('Excerpt is required.')).toBeVisible()
    await expect(page.getByText('Title is required.')).not.toBeVisible()
    await expect(page.getByText('Body is required.')).toBeVisible()
  })
})
