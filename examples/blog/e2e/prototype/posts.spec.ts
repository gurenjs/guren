import { test, expect, type Page } from '@playwright/test'

// The fixture in resources/js/prototype/index.ts is the only data source here:
// no Bun server, no database. Every navigation goes through the prototype
// HttpClient, and a direct load of a deep URL goes through the host's 404
// fallback first.

async function waitForHydrated(page: Page) {
  await page.waitForSelector('main[data-hydrated="true"]')
}

// State lives in the tab's sessionStorage, and every test gets a fresh browser
// context, so a test that needs a post it can change creates it itself.
async function createPost(page: Page, title: string): Promise<string> {
  await page.goto('/posts/new')
  await waitForHydrated(page)
  await page.getByLabel('Title').fill(title)
  await page.getByLabel('Excerpt').fill('Created during the walkthrough.')
  await page.getByLabel('Body').fill('The customer typed this during the walkthrough.')
  await Promise.all([
    page.waitForURL(/\/posts\/\d+$/),
    page.getByRole('button', { name: 'Create Post' }).click(),
  ])
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
  return page.url()
}

test.describe('prototype build', () => {
  test.describe.configure({ mode: 'serial' })

  test('deep links render straight from the static host', async ({ page }) => {
    const response = await page.goto('/posts/1')

    // GitHub Pages answers a missing path with 404.html and a 404 status; the
    // app still boots and resolves the page from the URL.
    expect([200, 404]).toContain(response?.status())
    await expect(page.getByRole('heading', { name: 'Hello from the static build' })).toBeVisible()
    await expect(page.getByText('This page was served from a plain file host.')).toBeVisible()
  })

  test('index lists the fixture posts for a signed-in demo author', async ({ page }) => {
    await page.goto('/posts')

    await expect(page.getByRole('heading', { name: 'Posts' })).toBeVisible()
    await expect(page.getByText('Prototype first, backend second')).toBeVisible()
    await expect(page.getByRole('link', { name: 'New post' })).toBeVisible()
  })

  test('client-side navigation between pages goes through the fixture', async ({ page }) => {
    await page.goto('/posts')
    await waitForHydrated(page)

    await Promise.all([
      page.waitForURL(/\/posts\/2$/),
      page.getByRole('link', { name: /Typed routes end to end/ }).click(),
    ])
    await expect(page.getByRole('heading', { name: 'Typed routes end to end' })).toBeVisible()
  })

  test('validation errors come back on the form', async ({ page }) => {
    await page.goto('/posts/new')
    await waitForHydrated(page)

    await page.getByLabel('Excerpt').fill('No title')
    await page.getByRole('button', { name: 'Create Post' }).click()

    await expect(page.getByText('Title is required.')).toBeVisible()
    await expect(page).toHaveURL(/\/posts\/new$/)
  })

  test('creating a post redirects to it and the list keeps it across a reload', async ({ page }) => {
    const url = await createPost(page, 'Written in the prototype')
    expect(url).toMatch(/\/posts\/4$/)

    await page.goto('/posts')
    await expect(page.getByText('Written in the prototype')).toBeVisible()

    await page.reload()
    await expect(page.getByText('Written in the prototype')).toBeVisible()
  })

  test('editing and deleting go through the fixture too', async ({ page }) => {
    const url = await createPost(page, 'Draft in the prototype')

    await page.goto(`${url}/edit`)
    await waitForHydrated(page)
    await page.getByLabel('Title').fill('Edited in the prototype')
    await Promise.all([
      page.waitForURL(url),
      page.getByRole('button', { name: 'Update Post' }).click(),
    ])
    await expect(page.getByRole('heading', { name: 'Edited in the prototype' })).toBeVisible()

    await page.goto(`${url}/edit`)
    await waitForHydrated(page)
    page.once('dialog', (dialog) => dialog.accept())
    await Promise.all([
      page.waitForURL(/\/posts$/),
      page.getByRole('button', { name: 'Delete Post' }).click(),
    ])
    await expect(page.getByText('Edited in the prototype')).toHaveCount(0)
    await expect(page.getByText('Prototype first, backend second')).toBeVisible()
  })

  test('?prototype.reset=1 discards the walkthrough state', async ({ page }) => {
    await createPost(page, 'Reset me')

    await page.goto('/posts?prototype.reset=1')
    await expect(page).toHaveURL(/\/posts$/)
    await expect(page.getByRole('heading', { name: 'Posts' })).toBeVisible()
    await expect(page.getByText('Reset me')).toHaveCount(0)
  })

  test('an unknown post renders the error page instead of a dialog', async ({ page }) => {
    await page.goto('/posts/999')

    await expect(page.getByText(/404/)).toBeVisible()
  })
})
