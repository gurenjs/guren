import { test, expect, type Page } from '@playwright/test'

async function createPost(page: Page, title: string) {
  await page.goto('/posts')
  await expect(page.getByRole('heading', { name: 'Posts' })).toBeVisible()

  await Promise.all([
    page.waitForURL('**/posts/new'),
    page.getByRole('link', { name: 'New post' }).click(),
  ])
  await expect(page.getByRole('heading', { name: 'New Post' })).toBeVisible()

  await page.getByLabel('Title').fill(title)
  await page.getByLabel('Excerpt').fill('An excerpt for the E2E test post.')
  await page.getByLabel('Body').fill('This is the body content created during E2E testing.')
  await expect(page.getByLabel('Title')).toHaveValue(title)

  await page.getByRole('button', { name: 'Create Post' }).click()
  await expect(page).toHaveURL(/\/posts(?:\/\d+)?$/)
  await expect(page.getByText(title)).toBeVisible()
}

test.describe('Posts — public', () => {
  test('posts index renders the list of posts', async ({ page }) => {
    await page.goto('/posts')

    await expect(page.getByRole('heading', { name: 'Posts' })).toBeVisible()
    await expect(page.locator('article').first()).toBeVisible()
  })

  test('viewing a single post shows its content', async ({ page }) => {
    await page.goto('/posts/1')

    await expect(page.getByRole('heading', { name: 'Introducing Guren' })).toBeVisible()
    await expect(page.getByText('A Laravel-inspired TypeScript framework powered by Bun.')).toBeVisible()
  })
})

test.describe('Posts — authenticated CRUD', () => {
  test.describe.configure({ mode: 'serial' })

  test('create a new post', async ({ page }) => {
    const title = `E2E Test Post ${Date.now()}`
    await createPost(page, title)
  })

  test('edit an existing post', async ({ page }) => {
    const originalTitle = `Editable E2E Post ${Date.now()}`
    const updatedTitle = `${originalTitle} Updated`

    await createPost(page, originalTitle)

    if (/\/posts$/.test(page.url())) {
      await Promise.all([
        page.waitForURL(/\/posts\/\d+$/),
        page.getByRole('link', { name: new RegExp(originalTitle) }).click(),
      ])
    }

    await page.goto(`${page.url()}/edit`)

    await expect(page.getByRole('heading', { name: 'Edit Post' })).toBeVisible()

    const titleInput = page.getByLabel('Title')
    await expect(titleInput).toHaveValue(originalTitle)

    await titleInput.clear()
    await titleInput.pressSequentially(updatedTitle)
    await expect(titleInput).toHaveValue(updatedTitle)

    await Promise.all([
      page.waitForURL(/\/posts\/\d+$/),
      page.getByRole('button', { name: 'Update Post' }).click(),
    ])
    await expect(page.getByRole('heading', { name: updatedTitle })).toBeVisible()
  })
})
