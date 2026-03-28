import { test, expect } from '@playwright/test'

test.describe('Posts — public', () => {
  test('posts index renders the list of posts', async ({ page }) => {
    await page.goto('/posts')
    await page.waitForLoadState('networkidle')

    await expect(page.getByRole('heading', { name: 'Posts' })).toBeVisible()
    // Verify at least one post article is rendered (posts may be paginated)
    await expect(page.locator('article').first()).toBeVisible({ timeout: 10_000 })
  })

  test('viewing a single post shows its content', async ({ page }) => {
    // Navigate directly to the first seeded post
    await page.goto('/posts/1')
    await page.waitForLoadState('networkidle')

    await expect(page.getByRole('heading', { name: 'Introducing Guren' })).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText('A Laravel-inspired TypeScript framework powered by Bun.')).toBeVisible()
  })
})

test.describe('Posts — authenticated CRUD', () => {
  test.describe.configure({ mode: 'serial' })

  const uniqueTitle = `E2E Test Post ${Date.now()}`

  test('create a new post', async ({ page }) => {
    await page.goto('/posts')
    await page.waitForLoadState('networkidle')

    await page.getByRole('link', { name: 'New post' }).click()
    await page.waitForURL('/posts/new', { timeout: 10_000 })
    await expect(page.getByRole('heading', { name: 'New Post' })).toBeVisible()

    await page.getByLabel('Title').fill(uniqueTitle)
    await page.getByLabel('Excerpt').fill('An excerpt for the E2E test post.')
    await page.getByLabel('Body').fill('This is the body content created during E2E testing.')
    await page.getByRole('button', { name: 'Create Post' }).click()

    // Controller redirects to /posts/:id or /posts after creation
    await page.waitForURL(/\/posts/)
    await expect(page.getByText(uniqueTitle)).toBeVisible({ timeout: 10_000 })
  })

  test('edit an existing post', async ({ page }) => {
    // Navigate to the first seeded post's edit page
    await page.goto('/posts/1/edit')
    await page.waitForLoadState('networkidle')

    await expect(page.getByRole('heading', { name: 'Edit Post' })).toBeVisible()

    const titleInput = page.getByLabel('Title')
    await expect(titleInput).toHaveValue('Introducing Guren')

    // Modify the title and save
    await titleInput.clear()
    await titleInput.fill('Introducing Guren (Updated)')
    await page.getByRole('button', { name: 'Update Post' }).click()

    // Controller redirects to /posts/:id after update
    await page.waitForURL(/\/posts\/\d+/, { timeout: 10_000 })
    await expect(page.getByText('Introducing Guren (Updated)')).toBeVisible()

    // Restore the original title for idempotency
    await page.goto('/posts/1/edit')
    await page.waitForLoadState('networkidle')
    const restoreInput = page.getByLabel('Title')
    await restoreInput.clear()
    await restoreInput.fill('Introducing Guren')
    await page.getByRole('button', { name: 'Update Post' }).click()
    await page.waitForURL(/\/posts\/\d+/, { timeout: 10_000 })
  })
})
