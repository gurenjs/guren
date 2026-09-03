import { test, expect, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gotoHydrated, waitForHydrated } from './helpers.js'

const coverFixture = fileURLToPath(new URL('./fixtures/cover.png', import.meta.url))

/**
 * Where the `local` disk (StorageProvider's ./storage/app, relative to the app
 * root the E2E server runs from) holds one attachment's objects, given the
 * signed delivery URL its id came from.
 */
function storageDirFor(deliveryUrl: string): string {
  const id = decodeURIComponent(new URL(deliveryUrl, 'http://localhost').pathname.split('/')[2] ?? '')
  return fileURLToPath(new URL(`../storage/app/attachments/${id}`, import.meta.url))
}

/** Creates a post and returns its show-page URL. */
async function createPost(page: Page, title: string, options: { cover?: boolean } = {}): Promise<string> {
  await page.goto('/posts')
  await expect(page.getByRole('heading', { name: 'Posts' })).toBeVisible()

  await Promise.all([
    page.waitForURL('**/posts/new'),
    page.getByRole('link', { name: 'New post' }).click(),
  ])
  await expect(page.getByRole('heading', { name: 'New Post' })).toBeVisible()
  await waitForHydrated(page)

  await page.getByLabel('Title').fill(title)
  await page.getByLabel('Excerpt').fill('An excerpt for the E2E test post.')
  await page.getByLabel('Body').fill('This is the body content created during E2E testing.')
  await expect(page.getByLabel('Title')).toHaveValue(title)

  if (options.cover) {
    await page.getByLabel('Cover image').setInputFiles(coverFixture)
    // The client-side object-URL preview confirms the file registered.
    await expect(page.getByTestId('cover-preview')).toBeVisible()
  }

  await page.getByRole('button', { name: 'Create Post' }).click()
  await expect(page).toHaveURL(/\/posts(?:\/\d+)?$/)
  await expect(page.getByText(title)).toBeVisible()

  // store() redirects to the show page; if we landed on the index instead,
  // click through so callers always get the post's own URL.
  if (page.url().endsWith('/posts')) {
    await Promise.all([
      page.waitForURL(/\/posts\/\d+$/),
      page.getByRole('link', { name: new RegExp(title) }).click(),
    ])
  }

  return page.url()
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

  test('create a post with a cover image', async ({ page }) => {
    const title = `E2E Cover Post ${Date.now()}`
    const postUrl = await createPost(page, title, { cover: true })

    // The cover lives on the private disk, so the show page renders it through
    // the signed delivery route rather than as a static asset.
    const cover = page.getByTestId('post-cover')
    await expect(cover).toBeVisible()
    await expect(cover).toHaveAttribute('src', /^\/attachments\/[^/]+\/.*[?&]signature=/)

    // The bytes must actually come back over HTTP — a broken image keeps
    // naturalWidth at 0 even though the element is "visible".
    await expect
      .poll(async () => cover.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0)

    // The edit form shows the current cover and replacing hint.
    await gotoHydrated(page, `${postUrl}/edit`)
    await expect(page.getByTestId('cover-preview')).toBeVisible()
    await expect(page.getByText('Choosing a new image replaces the current cover.')).toBeVisible()
  })

  test('delete a post removes it and its attachments', async ({ page }) => {
    const title = `E2E Deletable Post ${Date.now()}`
    const postUrl = await createPost(page, title, { cover: true })

    const coverSrc = await page.getByTestId('post-cover').getAttribute('src')
    expect(coverSrc).toMatch(/^\/attachments\/[^/]+\/.*[?&]signature=/)

    // Assert the bytes are on disk *before* deleting, so the "gone afterwards"
    // check below cannot pass by pointing at a path that never existed.
    const storedObjects = storageDirFor(coverSrc!)
    expect(existsSync(storedObjects)).toBe(true)

    // The Delete button's confirm dialog only exists once React has hydrated.
    await gotoHydrated(page, `${postUrl}/edit`)
    page.once('dialog', (dialog) => dialog.accept())
    await Promise.all([
      page.waitForURL(/\/posts$/),
      page.getByRole('button', { name: 'Delete Post' }).click(),
    ])

    // The record is gone…
    const showResponse = await page.request.get(postUrl)
    expect(showResponse.status()).toBe(404)

    // …its signed URL stops resolving…
    const coverResponse = await page.request.get(coverSrc!)
    expect(coverResponse.status()).toBe(404)

    // …and purgeAttachments removed the stored object too. Worth asserting
    // separately: the delivery route 404s on the missing row before it ever
    // touches storage, so the status above says nothing about the bytes.
    expect(existsSync(storedObjects)).toBe(false)
  })

  test('edit an existing post', async ({ page }) => {
    const originalTitle = `Editable E2E Post ${Date.now()}`
    const updatedTitle = `${originalTitle} Updated`

    const postUrl = await createPost(page, originalTitle)

    await gotoHydrated(page, `${postUrl}/edit`)

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
