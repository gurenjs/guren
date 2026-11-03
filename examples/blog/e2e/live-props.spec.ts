import { test, expect, type Browser, type Page } from '@playwright/test'
import { gotoHydrated, waitForHydrated } from './helpers.js'

// A guest in its own context watches while the signed-in author writes. The
// marker survives only if the watcher's page was never reloaded, so a passing
// assertion means the change arrived through a live prop's partial reload.
async function openWatcher(browser: Browser, path: string): Promise<Page> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  const watcher = await context.newPage()
  const socketOpened = watcher.waitForEvent('websocket', (socket) => socket.url().includes('/broadcasting/socket'))
  await gotoHydrated(watcher, path)
  await socketOpened
  await watcher.evaluate(() => {
    (window as unknown as { liveMarker: string }).liveMarker = 'not reloaded'
  })
  return watcher
}

async function expectNotReloaded(watcher: Page): Promise<void> {
  expect(await watcher.evaluate(() => (window as unknown as { liveMarker?: string }).liveMarker)).toBe('not reloaded')
}

async function createPost(page: Page, title: string): Promise<string> {
  await gotoHydrated(page, '/posts/new')
  await page.getByLabel('Title').fill(title)
  await page.getByLabel('Excerpt').fill('Written while another browser watches.')
  await page.getByLabel('Body').fill('This post shows up in the other browser without a refresh.')
  await expect(page.getByLabel('Title')).toHaveValue(title)
  await Promise.all([
    page.waitForURL(/\/posts\/\d+$/),
    page.getByRole('button', { name: 'Create Post' }).click(),
  ])
  return page.url()
}

test.describe('Live props', () => {
  test.describe.configure({ mode: 'serial' })

  test('a new post appears on an open posts index', async ({ browser, page }) => {
    const watcher = await openWatcher(browser, '/posts')
    const title = `Live Index Post ${Date.now()}`

    await createPost(page, title)

    await expect(watcher.getByRole('link', { name: new RegExp(title) })).toBeVisible()
    await expectNotReloaded(watcher)
    await watcher.context().close()
  })

  test('an edited post updates on an open show page', async ({ browser, page }) => {
    const originalTitle = `Live Show Post ${Date.now()}`
    const updatedTitle = `${originalTitle} Edited`
    const postUrl = await createPost(page, originalTitle)
    const watcher = await openWatcher(browser, new URL(postUrl).pathname)
    await expect(watcher.getByRole('heading', { name: originalTitle })).toBeVisible()

    await gotoHydrated(page, `${postUrl}/edit`)
    const titleInput = page.getByLabel('Title')
    await titleInput.clear()
    await titleInput.pressSequentially(updatedTitle)
    await expect(titleInput).toHaveValue(updatedTitle)
    await Promise.all([
      page.waitForURL(/\/posts\/\d+$/),
      page.getByRole('button', { name: 'Update Post' }).click(),
    ])
    await waitForHydrated(page)

    await expect(watcher.getByRole('heading', { name: updatedTitle })).toBeVisible()
    await expectNotReloaded(watcher)
    await watcher.context().close()
  })
})
